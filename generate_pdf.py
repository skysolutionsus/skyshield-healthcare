import base64
import os
import subprocess

def get_base64_img(path):
    try:
        if not os.path.exists(path): return ""
        with open(path, "rb") as image_file:
            ext = path.split('.')[-1]
            return f"data:image/{ext};base64," + base64.b64encode(image_file.read()).decode('utf-8')
    except Exception as e:
        print(f"Failed to load image {path}: {e}")
        return ""

logo_b64 = get_base64_img("/Users/japesg/dev/irs-skyshield/public/logo.png")
irs_b64 = get_base64_img("/Users/japesg/dev/irs-skyshield/public/irs-logo.png")

html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
    <style>
        :root {{
            --primary: #0A192F;
            --secondary: #2563EB;
            --accent: #38BDF8;
            --text-main: #1E293B;
            --text-light: #64748B;
            --bg-light: #F8FAFC;
            --white: #FFFFFF;
            --border: #E2E8F0;
        }}

        @page {{
            size: letter;
            margin: 0;
        }}

        body {{
            font-family: 'Inter', sans-serif;
            margin: 0;
            padding: 0;
            color: var(--text-main);
            background: var(--white);
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            width: 8.5in;
            height: 11in;
            box-sizing: border-box;
            position: relative;
            overflow: hidden;
        }}

        .container {{
            padding: 0.4in;
            height: 100%;
            display: flex;
            flex-direction: column;
            box-sizing: border-box;
        }}

        header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 0.15in;
            border-bottom: 2px solid var(--border);
            margin-bottom: 0.15in;
            flex-shrink: 0;
        }}

        .logos {{
            display: flex;
            align-items: center;
            gap: 15px;
        }}

        .logos img {{
            height: 40px;
            object-fit: contain;
        }}

        .header-text {{
            text-align: right;
        }}

        .header-text h1 {{
            color: var(--primary);
            font-size: 15pt;
            font-weight: 800;
            margin: 0;
            letter-spacing: -0.5px;
        }}

        .header-text p {{
            color: var(--secondary);
            font-size: 8.5pt;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin: 4px 0 0 0;
        }}

        .hero {{
            background: linear-gradient(135deg, var(--primary) 0%, #17365D 100%);
            color: var(--white);
            padding: 0.2in;
            border-radius: 10px;
            margin-bottom: 0.15in;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
            flex-shrink: 0;
        }}

        .hero h2 {{
            margin: 0 0 8px 0;
            font-size: 15pt;
            font-weight: 700;
            line-height: 1.2;
            color: var(--white);
        }}

        .hero p {{
            margin: 0;
            font-size: 10pt;
            font-weight: 300;
            opacity: 0.95;
            line-height: 1.4;
        }}

        .grid-2 {{
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.15in;
            margin-bottom: 0.15in;
            flex-shrink: 0;
        }}

        .card {{
            background: var(--bg-light);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.15in;
        }}

        .card h3 {{
            color: var(--primary);
            font-size: 11.5pt;
            font-weight: 700;
            margin: 0 0 8px 0;
            display: flex;
            align-items: center;
            gap: 8px;
        }}
        
        .card h3 svg {{
            width: 18px;
            height: 18px;
            color: var(--secondary);
        }}

        .card p {{
            font-size: 8.5pt;
            line-height: 1.5;
            margin: 0 0 8px 0;
            color: var(--text-main);
        }}

        .card ul {{
            margin: 0;
            padding-left: 18px;
            font-size: 8.5pt;
        }}

        .card li {{
            margin-bottom: 6px;
            line-height: 1.35;
        }}

        .highlight {{
            font-weight: 600;
            color: var(--secondary);
        }}

        .danger {{
            color: #DC2626;
            font-weight: 600;
        }}

        .architecture {{
            background: var(--white);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.15in;
            margin-bottom: 0.15in;
            flex-shrink: 0;
        }}

        .architecture h3 {{
            color: var(--primary);
            font-size: 11.5pt;
            font-weight: 700;
            margin: 0 0 10px 0;
            text-align: center;
        }}

        .arch-grid {{
            display: grid;
            grid-template-columns: 1fr 30px 1fr;
            align-items: center;
            gap: 10px;
        }}

        .arch-step {{
            background: var(--bg-light);
            border-left: 4px solid var(--secondary);
            padding: 10px 12px;
            border-radius: 6px;
        }}

        .arch-step h4 {{
            color: var(--primary);
            font-size: 10pt;
            margin: 0 0 6px 0;
        }}

        .arch-step ul {{
            margin: 0;
            padding-left: 15px;
            font-size: 8.5pt;
        }}

        .arch-step li {{
            margin-bottom: 4px;
        }}

        .arch-arrow {{
            text-align: center;
            color: var(--secondary);
            font-size: 20px;
            font-weight: bold;
        }}

        .benefits-title {{
            color: var(--primary);
            font-size: 11.5pt;
            font-weight: 700;
            margin: 0 0 10px 0;
            text-align: center;
            flex-shrink: 0;
        }}

        .benefits {{
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 10px;
            margin-bottom: auto;
        }}

        .benefit-card {{
            background: var(--primary);
            color: var(--white);
            padding: 12px;
            border-radius: 6px;
            text-align: center;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            display: flex;
            flex-direction: column;
        }}

        .benefit-icon {{
            margin-bottom: 6px;
        }}
        
        .benefit-icon svg {{
            width: 20px;
            height: 20px;
            color: var(--accent);
        }}

        .benefit-card h4 {{
            margin: 0 0 4px 0;
            font-size: 9pt;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--white);
        }}

        .benefit-card p {{
            margin: 0;
            font-size: 8pt;
            font-weight: 300;
            opacity: 0.9;
            line-height: 1.4;
        }}

        .tags {{
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 6px;
            margin-top: 10px;
        }}

        .tag {{
            background: #E0E7FF;
            color: var(--secondary);
            font-size: 7.5pt;
            padding: 3px 8px;
            border-radius: 12px;
            font-weight: 600;
        }}

        footer {{
            text-align: center;
            padding-top: 12px;
            border-top: 1px solid var(--border);
            color: var(--text-light);
            font-size: 8pt;
            margin-top: 12px;
            flex-shrink: 0;
        }}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <div class="logos">
                <img src="{logo_b64}" alt="SkyShield Logo" />
                <img src="{irs_b64}" alt="IRS Logo" />
            </div>
            <div class="header-text">
                <h1>SkyShield AI Compliance Platform</h1>
                <p>IRS Office of Safeguards</p>
            </div>
        </header>

        <div class="hero">
            <h2>Next-Generation Intelligence & Compliance</h2>
            <p>Empowering the IRS Office of Safeguards with a highly secure, intelligent, and accurate Retrieval-Augmented Generation (RAG) platform to navigate Publication 1075 and ever-evolving technical guidelines seamlessly.</p>
        </div>

        <div class="grid-2">
            <div class="card">
                <h3>
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>
                    The Challenge
                </h3>
                <p>The Office of Safeguards relies on <strong>Publication 1075</strong>, encompassing hundreds of pages. Traditional methods fall short:</p>
                <ul>
                    <li><span class="danger">Search Limitations:</span> Standard keyword search misses semantic meaning and context necessary to parse complex agency questions.</li>
                    <li><span class="danger">Scattered Guidance:</span> Vital answers aren't solely in Pub 1075; they rely on NIST standards and specific technology guidelines unseen by basic searches.</li>
                    <li><span class="danger">Public AI Risks:</span> Commercial LLMs (like ChatGPT) risk exposing <strong>FTI</strong> and <strong>PII</strong>, suffer from hallucinations, and cite outdated regulations.</li>
                </ul>
            </div>

            <div class="card">
                <h3>
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"></path></svg>
                    The SkyShield Solution
                </h3>
                <p>We built a secure, private AI compliance platform engineered specifically for the IRS, bypassing commercial LLM vulnerabilities entirely.</p>
                <ul>
                    <li><span class="highlight">Ironclad Security:</span> Intercepts and blocks FTI and PII <em>before</em> it ever reaches inference.</li>
                    <li><span class="highlight">Zero Hallucination:</span> Dedicated scoping strictly utilizing verified Publication 1075 and IRS data, enforcing factual responses.</li>
                    <li><span class="highlight">Comprehensive Governance:</span> Built-in role-based access control (RBAC), user logging, and an executive dashboard for tracking and reporting.</li>
                </ul>
            </div>
        </div>

        <div class="architecture">
            <h3>Architecture & Methodology</h3>
            <div class="arch-grid">
                <div class="arch-step">
                    <h4>Part 1: Data Ingestion & ETL</h4>
                    <ul>
                        <li><span class="highlight">Dynamic Uploads:</span> Ingests Pub 1075, Interim Guidance, SCSEMs, and CIS benchmarks.</li>
                        <li><span class="highlight">Agentic Contextual Chunking:</span> Uses a specialized micro-LLM to intelligently segment data, injecting context into each chunk to guarantee pristine retrieval.</li>
                        <li><span class="highlight">Vector Database:</span> Stores high-fidelity embeddings in an encrypted Postgres vector database.</li>
                    </ul>
                </div>
                <div class="arch-arrow">→</div>
                <div class="arch-step">
                    <h4>Part 2: Active AI Engine</h4>
                    <ul>
                        <li><span class="highlight">Precision Retrieval:</span> Employs advanced semantic search to pull chunks, subsequently <em>re-ranking</em> them for definitive accuracy.</li>
                        <li><span class="highlight">Robust Guardrails:</span> Full incident response logging actively shields all inferences against data leakage.</li>
                        <li><span class="highlight">Review Workflows:</span> Enhances downstream Quality Control (QC) and Quality Review (QR) processes seamlessly.</li>
                    </ul>
                </div>
            </div>
            <div class="tags">
                <span class="tag">Postgres Vector DB</span>
                <span class="tag">Agentic Chunking</span>
                <span class="tag">Re-Ranking</span>
                <span class="tag">FTI/PII Guardrails</span>
                <span class="tag">RBAC / Real-Time Auditing</span>
                <span class="tag">Data Privacy</span>
            </div>
        </div>

        <h3 class="benefits-title">Transforming Technical Review Operations</h3>
        <div class="benefits">
            <div class="benefit-card">
                <div class="benefit-icon">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                </div>
                <h4>Efficiency</h4>
                <p>Reduces 1-2 hours of deep technical inquiry into minutes. Exponentially accelerates subsequent QC and QR processes.</p>
            </div>
            <div class="benefit-card">
                <div class="benefit-icon">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </div>
                <h4>Accuracy</h4>
                <p>Relentlessly cross-references Pub 1075, NIST standards, and tech guides without missing critical dependencies.</p>
            </div>
            <div class="benefit-card">
                <div class="benefit-icon">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                </div>
                <h4>Consistency</h4>
                <p>Replaces divergent individual reviewer opinions with a unified voice strictly backed by verifiable citations.</p>
            </div>
            <div class="benefit-card">
                <div class="benefit-icon">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
                </div>
                <h4>SCSEM Updates (WIP)</h4>
                <p>Automatically keeps SCSEM guidelines compliant in real-time, ingesting emerging TIs and CIS benchmarks.</p>
            </div>
        </div>

        <footer>
            Prepared for the IRS Office of Safeguards &bull; SkyShield AI Compliance Platform &bull; Securing Tomorrow
        </footer>
    </div>
</body>
</html>"""

html_path = "/Users/japesg/dev/irs-skyshield/SkyShield_One_Pager.html"
with open(html_path, "w") as f:
    f.write(html_content)

print("HTML file written.")

cmd = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "--headless",
    "--disable-gpu",
    "--print-to-pdf=/Users/japesg/dev/irs-skyshield/SkyShield_Office_of_Safeguards_Pitch.pdf",
    "--no-pdf-header-footer",
    "--no-margins",
    f"file://{html_path}"
]

subprocess.run(cmd)
print("PDF generation command completed.")
