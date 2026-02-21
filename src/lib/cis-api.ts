import * as fs from 'fs';
import * as path from 'path';

const API_BASE_URL = 'https://workbench.cisecurity.org/api/vendor/v1';

export interface CISBenchmark {
    id: number;
    title: string;
    version: string;
    publishedDate: string;
    assessmentStatus: string;
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
 * Fetches the list of all available CIS Benchmarks.
 * @param token The Bearer token obtained from getCISToken()
 */
export async function fetchAllBenchmarks(token: string): Promise<CISBenchmark[]> {
    try {
        const response = await fetch(`${API_BASE_URL}/benchmarks`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to fetch CIS Benchmarks (${response.status}): ${errorText}`);
        }

        // Expected to return an array of benchmarks based on standard API practices
        // Documentation specifies /benchmarks returns this list.
        const benchmarks: CISBenchmark[] = await response.json();
        return benchmarks;

    } catch (error) {
        console.error("Error fetching CIS Benchmarks:", error);
        throw error;
    }
}
