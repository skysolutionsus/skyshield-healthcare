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
    assessmentStatus: string;
    availableFormats: string[];
    profile: Array<{ profileId: string; profileTitle: string }>;
}

/**
 * Reads the local CIS SecureSuite license.xml file.
 * In a real production environment, this might pull from a secret manager or DB.
 */
function getLicenseXML(): string {
    const licensePath = path.join(process.cwd(), 'assets', 'license.xml');
    try {
        const xml = fs.readFileSync(licensePath, 'utf8');
        return xml;
    } catch (error) {
        console.error("Failed to read CIS license XML:", error);
        throw new Error("Missing or unreadable assets/license.xml file.");
    }
}

/**
 * Exchanges the license.xml literal string for a 20-minute JWT token.
 * 
 * @returns {Promise<string>} The JWT Bearer token
 */
export async function getCISToken(): Promise<string> {
    const xmlBody = getLicenseXML();

    try {
        const response = await fetch(`${API_BASE_URL}/license`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/xml',
                'Accept': 'application/json'
            },
            body: xmlBody
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`CIS Auth Failed (${response.status}): ${errorText}`);
        }

        /* 
         * Depending on the exact WorkBench API response, the token might be 
         * returned as a direct string, or nested in JSON like { "token": "..." }.
         * Their documentation indicates it returns the authorization token upon success.
         */
        const textResponse = await response.text();

        try {
            // Try parsing as JSON first
            const json = JSON.parse(textResponse);
            return json.token || json.access_token || textResponse;
        } catch {
            // If it's not JSON, assume it's the raw JWT string
            return textResponse;
        }

    } catch (error) {
        console.error("Error authenticating with CIS WorkBench API:", error);
        throw error;
    }
}

/**
 * Fetches the list of all available CIS Benchmarks from the WorkBench API.
 * Uses the X-SecureSuite-Token header as required by the CIS API docs.
 * @param token The token obtained from getCISToken()
 */
export async function fetchAllBenchmarks(token: string): Promise<CISBenchmark[]> {
    try {
        const response = await fetch(`${API_BASE_URL}/benchmarks`, {
            method: 'GET',
            headers: {
                'X-SecureSuite-Token': token,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch CIS Benchmarks (${response.status}): ${errorText}`);
        }

        // CIS API returns { "Total number of results": N, "Benchmarks": [...] }
        const data = await response.json();
        const benchmarks: CISBenchmark[] = data.Benchmarks || data;
        return benchmarks;

    } catch (error) {
        console.error("Error fetching CIS Benchmarks:", error);
        throw error;
    }
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

        if (!response.ok) {
            const errorText = await response.text();
            console.warn(`Failed to fetch benchmark ${workbenchId} (${response.status}): ${errorText}`);
            return null;
        }

        const data = await response.json();
        // Single benchmark detail may be wrapped in an array
        const benchmark = Array.isArray(data) ? data[0] : (data.Benchmarks ? data.Benchmarks[0] : data);
        return benchmark;

    } catch (error) {
        console.error(`Error fetching CIS Benchmark ${workbenchId}:`, error);
        return null;
    }
}
