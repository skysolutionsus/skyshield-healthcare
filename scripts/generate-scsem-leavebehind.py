import base64
import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "output" / "pdf"
HTML_PATH = OUTPUT_DIR / "SkyShield_SCSEM_Update_Workflow.html"
PDF_PATH = OUTPUT_DIR / "SkyShield_SCSEM_Update_Workflow.pdf"


def image_data_uri(path: Path) -> str:
    if not path.exists():
        return ""
    ext = path.suffix.lower().lstrip(".")
    if ext == "jpg":
        ext = "jpeg"
    with path.open("rb") as image_file:
        encoded = base64.b64encode(image_file.read()).decode("utf-8")
    return f"data:image/{ext};base64,{encoded}"


def write_html() -> None:
    logo_b64 = image_data_uri(ROOT / "public" / "logo.png")
    irs_b64 = image_data_uri(ROOT / "public" / "irs-logo.png")

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>
        :root {{
            --primary: #0A192F;
            --primary-soft: #17365D;
            --secondary: #2563EB;
            --accent: #38BDF8;
            --success: #059669;
            --warning: #D97706;
            --danger: #DC2626;
            --violet: #7C3AED;
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

        * {{
            box-sizing: border-box;
        }}

        body {{
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            margin: 0;
            padding: 0;
            color: var(--text-main);
            background: var(--white);
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            width: 8.5in;
            height: 11in;
            overflow: hidden;
        }}

        .container {{
            width: 100%;
            height: 100%;
            padding: 0.35in 0.38in;
            display: flex;
            flex-direction: column;
        }}

        header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 0.11in;
            border-bottom: 2px solid var(--border);
            margin-bottom: 0.12in;
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
        }}

        .header-text p {{
            color: var(--secondary);
            font-size: 8.5pt;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1px;
            margin: 4px 0 0 0;
        }}

        .hero {{
            background: linear-gradient(135deg, var(--primary) 0%, var(--primary-soft) 100%);
            color: var(--white);
            padding: 0.16in 0.2in;
            border-radius: 10px;
            margin-bottom: 0.12in;
            display: grid;
            grid-template-columns: 1fr 1.35in;
            gap: 0.18in;
            align-items: center;
            box-shadow: 0 6px 14px rgba(10, 25, 47, 0.16);
            flex-shrink: 0;
        }}

        .hero h2 {{
            margin: 0 0 8px 0;
            font-size: 15.7pt;
            font-weight: 800;
            line-height: 1.15;
            color: var(--white);
        }}

        .hero p {{
            margin: 0;
            font-size: 8.7pt;
            font-weight: 400;
            opacity: 0.94;
            line-height: 1.38;
        }}

        .hero-stat {{
            background: rgba(255, 255, 255, 0.09);
            border: 1px solid rgba(255, 255, 255, 0.18);
            border-radius: 9px;
            padding: 10px 10px;
            text-align: center;
        }}

        .hero-stat strong {{
            display: block;
            color: var(--accent);
            font-size: 21pt;
            line-height: 1;
            font-weight: 800;
        }}

        .hero-stat span {{
            display: block;
            margin-top: 4px;
            font-size: 7.5pt;
            color: #DCEBFA;
            font-weight: 700;
            text-transform: uppercase;
        }}

        .grid-2 {{
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 0.15in;
            margin-bottom: 0.12in;
            flex-shrink: 0;
        }}

        .card {{
            background: var(--bg-light);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.12in;
            min-height: 1.42in;
        }}

        .card h3,
        .section-title {{
            color: var(--primary);
            font-size: 11.5pt;
            font-weight: 800;
            margin: 0 0 7px 0;
            display: flex;
            align-items: center;
            gap: 8px;
        }}

        .accent-bar {{
            display: inline-block;
            width: 5px;
            height: 18px;
            border-radius: 3px;
            background: var(--secondary);
            flex: 0 0 auto;
        }}

        .danger-bar {{
            background: var(--danger);
        }}

        .success-bar {{
            background: var(--success);
        }}

        .card p {{
            font-size: 8.05pt;
            line-height: 1.34;
            margin: 0 0 6px 0;
            color: var(--text-main);
        }}

        .card ul {{
            margin: 0;
            padding-left: 16px;
            font-size: 7.95pt;
        }}

        .card li {{
            margin-bottom: 4px;
            line-height: 1.24;
        }}

        .highlight {{
            font-weight: 700;
            color: var(--secondary);
        }}

        .danger {{
            color: var(--danger);
            font-weight: 700;
        }}

        .architecture {{
            background: var(--white);
            border: 1px solid var(--border);
            border-radius: 8px;
            padding: 0.12in;
            margin-bottom: 0.12in;
            flex-shrink: 0;
        }}

        .architecture h3 {{
            color: var(--primary);
            font-size: 11.5pt;
            font-weight: 800;
            margin: 0 0 8px 0;
            text-align: center;
        }}

        .arch-grid {{
            display: grid;
            grid-template-columns: 1fr 30px 1fr;
            align-items: stretch;
            gap: 10px;
            margin-bottom: 6px;
        }}

        .arch-step {{
            background: var(--bg-light);
            border-left: 4px solid var(--secondary);
            padding: 8px 10px;
            border-radius: 6px;
        }}

        .arch-step.right {{
            border-left-color: var(--success);
        }}

        .arch-step h4 {{
            color: var(--primary);
            font-size: 9.1pt;
            margin: 0 0 5px 0;
        }}

        .arch-step ul {{
            margin: 0;
            padding-left: 15px;
            font-size: 7.65pt;
        }}

        .arch-step li {{
            margin-bottom: 3px;
            line-height: 1.2;
        }}

        .arch-arrow {{
            display: flex;
            align-items: center;
            justify-content: center;
            color: var(--secondary);
            font-size: 20px;
            font-weight: 800;
        }}

        .tags {{
            display: flex;
            flex-wrap: wrap;
            justify-content: center;
            gap: 5px;
            margin-top: 5px;
        }}

        .tag {{
            background: #E0E7FF;
            color: var(--secondary);
            font-size: 6.9pt;
            padding: 2px 7px;
            border-radius: 12px;
            font-weight: 700;
        }}

        .tag.green {{
            background: #DCFCE7;
            color: #047857;
        }}

        .tag.amber {{
            background: #FEF3C7;
            color: #B45309;
        }}

        .security {{
            display: grid;
            grid-template-columns: 1fr 1fr 1fr;
            gap: 0.1in;
            margin-bottom: 0.1in;
            flex-shrink: 0;
        }}

        .security-card {{
            border: 1px solid var(--border);
            border-radius: 7px;
            background: var(--white);
            padding: 8px 10px;
        }}

        .security-card h4 {{
            margin: 0 0 5px 0;
            color: var(--primary);
            font-size: 8.15pt;
            font-weight: 800;
        }}

        .security-card p {{
            margin: 0;
            color: var(--text-light);
            font-size: 7.05pt;
            line-height: 1.22;
        }}

        .impact {{
            display: grid;
            grid-template-columns: 1.18fr 2.25fr 1fr;
            gap: 10px;
            background: var(--primary);
            border-radius: 8px;
            padding: 10px;
            margin-bottom: auto;
            flex-shrink: 0;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }}

        .impact-copy {{
            padding: 4px 5px 3px 4px;
        }}

        .impact-copy h3 {{
            margin: 0 0 5px 0;
            color: var(--white);
            font-size: 10.5pt;
            font-weight: 800;
        }}

        .impact-copy p {{
            margin: 0;
            color: #DCEBFA;
            font-size: 6.95pt;
            line-height: 1.22;
        }}

        .impact-table {{
            display: grid;
            gap: 7px;
        }}

        .impact-row {{
            display: grid;
            grid-template-columns: 1.1fr 0.92fr 18px 0.82fr;
            align-items: center;
            gap: 7px;
            background: rgba(255,255,255,0.08);
            border: 1px solid rgba(255,255,255,0.15);
            border-radius: 7px;
            padding: 7px 8px;
        }}

        .impact-label {{
            color: var(--white);
            font-size: 7.05pt;
            line-height: 1.15;
            font-weight: 800;
        }}

        .impact-cell {{
            color: #DCEBFA;
            font-size: 5.95pt;
            line-height: 1.12;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.25px;
            text-align: center;
        }}

        .impact-cell strong {{
            display: block;
            color: var(--accent);
            font-size: 12.2pt;
            line-height: 1;
            font-weight: 800;
            margin-bottom: 3px;
            text-transform: none;
            letter-spacing: 0;
        }}

        .impact-arrow {{
            color: var(--accent);
            font-size: 13pt;
            font-weight: 800;
            text-align: center;
        }}

        .impact-summary {{
            background: #EFF6FF;
            border-color: #BFDBFE;
            border: 1px solid #BFDBFE;
            border-radius: 7px;
            padding: 10px 9px;
            text-align: center;
            display: flex;
            flex-direction: column;
            justify-content: center;
        }}

        .impact-summary strong {{
            display: block;
            color: var(--secondary);
            font-size: 19pt;
            line-height: 1;
            font-weight: 800;
            margin-bottom: 5px;
        }}

        .impact-summary span {{
            display: block;
            color: var(--text-main);
            font-size: 6.45pt;
            line-height: 1.15;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.25px;
        }}

        .impact-summary p {{
            margin: 6px 0 0 0;
            color: var(--text-light);
            font-size: 6.45pt;
            line-height: 1.16;
        }}

        footer {{
            text-align: center;
            padding-top: 8px;
            border-top: 1px solid var(--border);
            color: var(--text-light);
            font-size: 7.8pt;
            margin-top: 8px;
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
                <h1>SkyShield SCSEM Update Workflow</h1>
                <p>IRS Office of Safeguards</p>
            </div>
        </header>

        <section class="hero">
            <div>
                <h2>Auditable SCSEM Updates from Workbook Intake to Export</h2>
                <p>SkyShield compares an uploaded IRS SCSEM workbook against current CIS, STIG, and Publication 1075 evidence, then gives reviewers a governed way to approve, edit, reject, undo, and export only validated changes.</p>
            </div>
            <div class="hero-stat">
                <strong>5</strong>
                <span>Demo Actions</span>
                <p style="font-size:7.2pt; line-height:1.25; margin-top:6px;">upload, analyze, review, undo, export</p>
            </div>
        </section>

        <section class="grid-2">
            <div class="card">
                <h3><span class="accent-bar danger-bar"></span>The Challenge</h3>
                <p>SCSEMs must stay aligned with IRS Safeguards guidance and technology-specific security baselines. Manual upkeep creates predictable friction:</p>
                <ul>
                    <li><span class="danger">Slow comparison:</span> Reviewers have to reconcile workbook rows against changing CIS, STIG, and Publication 1075 language.</li>
                    <li><span class="danger">Evidence gaps:</span> It is hard to prove which source drove a proposed control update after the fact.</li>
                    <li><span class="danger">Customer questions:</span> Security, login, access control, and source integrity need to be addressed before the demo lands.</li>
                </ul>
            </div>

            <div class="card">
                <h3><span class="accent-bar success-bar"></span>The SkyShield Update Flow</h3>
                <p>The SCSEM Updater turns benchmark maintenance into a governed review workflow instead of a silent rewrite process.</p>
                <ul>
                    <li><span class="highlight">Evidence-backed:</span> Matches the uploaded workbook to current CIS and STIG workbook evidence.</li>
                    <li><span class="highlight">Reviewer-owned:</span> Proposed changes stay pending until a human approves, edits, rejects, or undoes them.</li>
                    <li><span class="highlight">Workbook-safe:</span> Export starts from the original XLSX and applies approved deltas only.</li>
                </ul>
            </div>
        </section>

        <section class="architecture">
            <h3>Workflow & Architecture Layers</h3>
            <div class="arch-grid">
                <div class="arch-step">
                    <h4>Part 1: Evidence Intake & Analysis</h4>
                    <ul>
                        <li><span class="highlight">React / Next.js UI:</span> Reviewer uploads the SCSEM workbook from the browser.</li>
                        <li><span class="highlight">Node.js API routes:</span> Server validates upload, parses workbook fields, and creates an auditable updater session.</li>
                        <li><span class="highlight">Evidence services:</span> CIS/STIG workbooks are selected, hashed, and compared with Pub 1075 context.</li>
                    </ul>
                </div>
                <div class="arch-arrow">→</div>
                <div class="arch-step right">
                    <h4>Part 2: Human Review & Export</h4>
                    <ul>
                        <li><span class="highlight">Review controls:</span> Approve, reject, edit proposed text, batch review, or undo the latest decision.</li>
                        <li><span class="highlight">Governed export:</span> Only approved changes are written back into the original workbook format.</li>
                        <li><span class="highlight">Audit trail:</span> Upload, analysis, review, edit, undo, and export events are logged with source metadata.</li>
                    </ul>
                </div>
            </div>
            <div class="tags">
                <span class="tag">React / Next.js UI</span>
                <span class="tag">Node.js API Routes</span>
                <span class="tag">Prisma / PostgreSQL</span>
                <span class="tag">Runtime XLSX Storage</span>
                <span class="tag">CIS / STIG Evidence</span>
                <span class="tag green">MFA / RBAC</span>
                <span class="tag green">Org-Scoped Sessions</span>
                <span class="tag amber">SHA-256 Source Hashes</span>
            </div>
        </section>

        <section class="security">
            <div class="security-card">
                <h4>Security Layers</h4>
                <p>Mandatory MFA, role checks, org-scoped updater sessions, security headers, upload limits, and Office Open XML file-signature checks.</p>
            </div>
            <div class="security-card">
                <h4>Safeguards Guardrails</h4>
                <p>PII/FTI prompts are blocked before AI calls; blocked attempts create incident records and audit events.</p>
            </div>
            <div class="security-card">
                <h4>Deployment Items</h4>
                <p>Agency hosting should validate TLS/FIPS, database encryption, network segmentation, backups, and SIEM forwarding.</p>
            </div>
        </section>

        <section class="impact">
            <div class="impact-copy">
                <h3>Projected Efficiency Impact</h3>
                <p>SkyShield shifts SCSEM maintenance from manual evidence assembly to reviewer validation by automating source matching, benchmark comparison, and first-draft change generation.</p>
                <p style="margin-top:4px;">Planning estimate; validate with pilot cycle-time data before reporting as measured savings.</p>
            </div>
            <div class="impact-table">
                <div class="impact-row">
                    <div class="impact-label">Small SCSEM Refresh</div>
                    <div class="impact-cell"><strong>20 hrs</strong>Current forecast</div>
                    <div class="impact-arrow">→</div>
                    <div class="impact-cell"><strong>1-2 hrs</strong>Tool-assisted estimate</div>
                </div>
                <div class="impact-row">
                    <div class="impact-label">New SCSEM Build</div>
                    <div class="impact-cell"><strong>80-120 hrs</strong>Current forecast</div>
                    <div class="impact-arrow">→</div>
                    <div class="impact-cell"><strong>&lt;5 hrs</strong>After setup and tuning</div>
                </div>
            </div>
            <div class="impact-summary">
                <strong>92-95%</strong>
                <span>Projected cycle effort reduction</span>
                <p>Roughly 15-20x less manual effort for the update workflow.</p>
            </div>
        </section>

        <footer>
            Prepared for the IRS Office of Safeguards &bull; SkyShield AI Compliance Platform &bull; SCSEM Update Demo Companion
        </footer>
    </div>
</body>
</html>"""

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    HTML_PATH.write_text(html, encoding="utf-8")


def chrome_path() -> str:
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    raise FileNotFoundError("Google Chrome or Chromium was not found.")


def build_pdf() -> None:
    write_html()
    command = [
        chrome_path(),
        "--headless",
        "--disable-gpu",
        f"--print-to-pdf={PDF_PATH}",
        "--no-pdf-header-footer",
        "--no-margins",
        f"file://{HTML_PATH}",
    ]
    subprocess.run(command, check=True)
    print(PDF_PATH)


if __name__ == "__main__":
    build_pdf()
