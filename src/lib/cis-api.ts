import * as fs from 'fs';
import * as path from 'path';

const API_BASE_URL = 'https://workbench.cisecurity.org/api/vendor/v1';

export interface CISBenchmark {
    workbenchId: number;
    benchmarkId: string;
    benchmarkTitle: string;
    benchmarkVersion: string;
    benchmarkStatus: {
        status: string;
        statusDate: string;
    };
    workbenchStatus?: {
        status: string;
    };
    assessmentStatus: string;
    availableFormats: string[];
    profile: Array<{ profileId: string; profileTitle: string }>;
}

export interface CISExcelFile {
    workbenchId: number;
    excelTitle: string;
    benchmarkTitle: string;
    excelFileName: string;
}

const MAX_LICENSE_BYTES = 1_000_000;

function validateLicenseXML(value: string, source: string): string {
    const xml = value.trim();
    if (!xml || xml.length > MAX_LICENSE_BYTES || !xml.startsWith("<") || !xml.endsWith(">")) {
        throw new Error(`CIS SecureSuite license material from ${source} is not valid XML.`);
    }
    return xml;
}

/**
 * Reads CIS SecureSuite license material supplied by the deployment. License
 * material is deliberately never read from the repository or runtime-data
 * directory, because both may be copied into backups or build artifacts.
 */
function getLicenseXML(): string {
    const encodedLicense = process.env.CIS_LICENSE_XML_BASE64?.trim();
    if (encodedLicense) {
        try {
            return validateLicenseXML(
                Buffer.from(encodedLicense, "base64").toString("utf8"),
                "CIS_LICENSE_XML_BASE64"
            );
        } catch (error) {
            if (error instanceof Error && error.message.includes("is not valid XML")) throw error;
            throw new Error("CIS_LICENSE_XML_BASE64 could not be decoded.");
        }
    }

    const configuredPath = process.env.CIS_LICENSE_XML_PATH?.trim();
    if (!configuredPath) {
        throw new Error(
            "CIS SecureSuite credentials are not configured. Set CIS_LICENSE_XML_PATH " +
            "to a secret-manager-mounted file or CIS_LICENSE_XML_BASE64 to an injected secret."
        );
    }

    const licensePath = path.resolve(configuredPath);
    try {
        const stat = fs.statSync(licensePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_LICENSE_BYTES) {
            throw new Error("configured path is not a non-empty license file of an expected size");
        }
        return validateLicenseXML(fs.readFileSync(licensePath, "utf8"), "CIS_LICENSE_XML_PATH");
    } catch {
        throw new Error("CIS_LICENSE_XML_PATH is missing, unreadable, or invalid.");
    }
}

async function requireSuccessfulResponse(response: Response, operation: string): Promise<void> {
    if (!response.ok) {
        // Do not echo response bodies: authentication services can return
        // credential-related material or operational details in error payloads.
        throw new Error(`${operation} failed with HTTP ${response.status}.`);
    }
}

/**
 * Exchanges the license.xml literal string for a 20-minute JWT token.
 * 
 * @returns {Promise<string>} The JWT Bearer token
 */
export async function getCISToken(): Promise<string> {
    const xmlBody = getLicenseXML();

    const response = await fetch(`${API_BASE_URL}/license`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/xml',
            'Accept': 'application/json'
        },
        body: xmlBody
    });

    await requireSuccessfulResponse(response, "CIS SecureSuite authentication");

    /*
     * Depending on the exact WorkBench API response, the token might be
     * returned as a direct string, or nested in JSON like { "token": "..." }.
     */
    const textResponse = (await response.text()).trim();

    try {
        const json = JSON.parse(textResponse) as { token?: unknown; access_token?: unknown };
        const token = typeof json.token === "string"
            ? json.token.trim()
            : typeof json.access_token === "string"
                ? json.access_token.trim()
                : "";
        if (!token) throw new Error("CIS SecureSuite authentication returned no token.");
        return token;
    } catch (error) {
        if (error instanceof SyntaxError) {
            const rawToken = textResponse.replace(/^"|"$/g, "").trim();
            if (rawToken) return rawToken;
        }
        if (error instanceof Error && error.message.includes("returned no token")) throw error;
        throw new Error("CIS SecureSuite authentication returned an unreadable token response.");
    }
}

/**
 * Fetches the list of all available CIS Benchmarks from the WorkBench API.
 * Uses the X-SecureSuite-Token header as required by the CIS API docs.
 * @param token The token obtained from getCISToken()
 */
export async function fetchAllBenchmarks(token: string): Promise<CISBenchmark[]> {
    const response = await fetch(`${API_BASE_URL}/benchmarks`, {
        method: 'GET',
        headers: {
            'X-SecureSuite-Token': token,
            'Accept': 'application/json'
        }
    });

    await requireSuccessfulResponse(response, "CIS Benchmark catalog retrieval");
    const data = await response.json() as { Benchmarks?: unknown } | unknown[];
    const benchmarks = Array.isArray(data)
        ? data
        : Array.isArray(data.Benchmarks)
            ? data.Benchmarks
            : null;
    if (!benchmarks) throw new Error("CIS Benchmark catalog response did not contain a benchmark list.");
    return benchmarks as CISBenchmark[];
}

/**
 * Fetches the list of available CIS Benchmark Excel workbooks.
 * These are separate from the benchmark serialization formats and are exposed
 * through the /excel resource in the SecureSuite Member API.
 */
export async function fetchAllBenchmarkExcelFiles(token: string): Promise<CISExcelFile[]> {
    const response = await fetch(`${API_BASE_URL}/excel`, {
        method: 'GET',
        headers: {
            'X-SecureSuite-Token': token,
            'Accept': 'application/json'
        }
    });

    await requireSuccessfulResponse(response, "CIS Benchmark Excel catalog retrieval");
    const data = await response.json() as { Excel?: unknown } | unknown[];
    const excel = Array.isArray(data)
        ? data
        : Array.isArray(data.Excel)
            ? data.Excel
            : null;
    if (!excel) throw new Error("CIS Benchmark Excel catalog response did not contain a workbook list.");
    return excel as CISExcelFile[];
}

/**
 * Downloads a CIS Benchmark Excel workbook by WorkBench ID.
 */
export async function downloadBenchmarkExcel(token: string, workbenchId: number): Promise<Buffer> {
    if (!Number.isSafeInteger(workbenchId) || workbenchId <= 0) {
        throw new Error("CIS Benchmark WorkBench ID must be a positive integer.");
    }
    const response = await fetch(`${API_BASE_URL}/excel/${workbenchId}`, {
        method: 'GET',
        headers: {
            'X-SecureSuite-Token': token,
            'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }
    });

    await requireSuccessfulResponse(response, `CIS Benchmark Excel ${workbenchId} download`);
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        throw new Error(`CIS Benchmark Excel ${workbenchId} did not look like an XLSX file.`);
    }

    return body;
}

/**
 * Fetches details for a specific benchmark by its WorkBench ID.
 * @param token The token obtained from getCISToken()
 * @param workbenchId The workbenchId of the benchmark
 */
export async function fetchBenchmarkById(token: string, workbenchId: number): Promise<CISBenchmark | null> {
    try {
        const response = await fetch(`${API_BASE_URL}/benchmarks/${workbenchId}`, {
            method: 'GET',
            headers: {
                'X-SecureSuite-Token': token,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) return null;

        const data = await response.json();
        // Single benchmark detail may be wrapped in an array
        const benchmark = Array.isArray(data) ? data[0] : (data.Benchmarks ? data.Benchmarks[0] : data);
        return benchmark;

    } catch {
        return null;
    }
}
