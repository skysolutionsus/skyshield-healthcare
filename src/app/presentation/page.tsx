import React from 'react';
import { Shield, BrainCircuit, FileSpreadsheet, Lock, Clock, CheckCircle2, Zap, BarChart3, Presentation, Users } from 'lucide-react';
import { SkyLogo } from '@/components/sky-logo';

export default function PresentationPage() {
    return (
        <div className="min-h-screen bg-[var(--sky-navy)] text-slate-300 selection:bg-sky-500/30 selection:text-sky-200 font-sans pb-32">

            {/* Minimalist Top Nav */}
            <nav className="fixed top-0 left-0 right-0 z-50 border-b border-[var(--sky-border)] bg-[var(--sky-navy)]/80 backdrop-blur-md">
                <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
                    <SkyLogo size={42} light={true} className="drop-shadow-[0_0_15px_rgba(33,150,243,0.3)]" />
                    <div className="flex items-center gap-4 text-sm font-medium">
                        <span className="text-slate-400">Office of Safeguards</span>
                        <span className="h-4 w-px bg-slate-700 font-medium"></span>
                        <span className="text-sky-400">Executive Briefing</span>
                    </div>
                </div>
            </nav>

            {/* Hero Section */}
            <main className="pt-40 max-w-7xl mx-auto px-6">
                <div className="relative isolate px-6 lg:px-8">
                    {/* Background glow effects */}
                    <div className="absolute inset-x-0 -top-40 -z-10 transform-gpu overflow-hidden blur-3xl sm:-top-80">
                        <div className="relative left-[calc(50%-11rem)] aspect-[1155/678] w-[36.125rem] -translate-x-1/2 rotate-[30deg] bg-gradient-to-tr from-sky-500 to-blue-800 opacity-20 sm:left-[calc(50%-30rem)] sm:w-[72.1875rem]" style={{ clipPath: 'polygon(74.1% 44.1%, 100% 61.6%, 97.5% 26.9%, 85.5% 0.1%, 80.7% 2%, 72.5% 32.5%, 60.2% 62.4%, 52.4% 68.1%, 47.5% 58.3%, 45.2% 34.5%, 27.5% 76.7%, 0.1% 64.9%, 17.9% 100%, 27.6% 76.8%, 76.1% 97.7%, 74.1% 44.1%)' }} />
                    </div>

                    <div className="mx-auto max-w-3xl text-center">
                        <div className="mb-8 flex justify-center">
                            <span className="relative rounded-full px-4 py-1.5 text-sm leading-6 text-sky-400 ring-1 ring-sky-500/20 bg-sky-500/10 font-medium tracking-wide">
                                Internal Alpha 1.0
                            </span>
                        </div>
                        <h1 className="text-5xl font-bold tracking-tight text-white sm:text-7xl mb-8 leading-tight drop-shadow-sm">
                            Intelligent Compliance & <span className="text-transparent bg-clip-text bg-gradient-to-r from-sky-400 to-blue-500">Safeguards Platform</span>
                        </h1>
                        <p className="mt-6 text-xl leading-8 text-[var(--sky-text-secondary)]">
                            Modernizing Publication 1075 Technical Inquiries and SCSEM Management through secure, localized Artificial Intelligence.
                        </p>
                    </div>
                </div>

                {/* Section 1: What It Is */}
                <div className="mt-32 sm:mt-40 max-w-5xl mx-auto">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
                        <div>
                            <div className="flex items-center gap-3 mb-4">
                                <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/20">
                                    <Presentation className="h-6 w-6 text-sky-400" />
                                </div>
                                <h2 className="text-sky-400 font-semibold tracking-wide uppercase text-sm">The Platform</h2>
                            </div>
                            <h3 className="text-3xl font-bold tracking-tight text-white sm:text-4xl mb-6">What is SkyShield?</h3>
                            <p className="text-lg leading-relaxed text-[var(--sky-text-secondary)] mb-6">
                                SkyShield is a centralized, AI-powered hub designed exclusively for the IRS Office of Safeguards. It consolidates the complex, fractured processes of Federal Tax Information (FTI) compliance into a single, intuitive interface.
                            </p>
                            <ul className="space-y-4 text-[var(--sky-text-secondary)]">
                                <li className="flex items-center gap-3">
                                    <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                                    <span>Single pane of glass for SCSEM templates and Incident tracking.</span>
                                </li>
                                <li className="flex items-center gap-3">
                                    <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                                    <span>Purpose-built LLM Agent trained on IRS Pub 1075 standards.</span>
                                </li>
                                <li className="flex items-center gap-3">
                                    <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0" />
                                    <span>Automated synchronization with latest CIS Benchmarks.</span>
                                </li>
                            </ul>
                        </div>
                        <div className="relative rounded-2xl bg-slate-900/50 border border-[var(--sky-border)] p-8 shadow-2xl overflow-hidden group">
                            <div className="absolute inset-0 bg-gradient-to-br from-sky-500/5 via-transparent to-blue-600/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500"></div>
                            <Shield className="w-32 h-32 text-slate-800 absolute -bottom-4 -right-4 transform rotate-12" />
                            <div className="relative z-10 space-y-6">
                                <div className="h-12 w-12 rounded-full bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center p-0.5 shadow-lg shadow-sky-500/20">
                                    <div className="w-full h-full bg-[var(--sky-navy)] rounded-full flex items-center justify-center">
                                        <Shield className="h-6 w-6 text-sky-400" />
                                    </div>
                                </div>
                                <p className="text-lg font-medium text-white">Replacing disjointed spreadsheets and manual portal searches with intelligent automation.</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Section 2: Technical Inquiries / AI Agent */}
                <div className="mt-32 sm:mt-40 border-t border-[var(--sky-border)] pt-32 max-w-5xl mx-auto">
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
                        <div className="order-2 lg:order-1 relative rounded-2xl bg-gradient-to-br from-indigo-900/40 to-slate-900 border border-indigo-500/20 p-8 shadow-2xl">
                            <div className="space-y-4">
                                {/* Mock Chat bubbles */}
                                <div className="bg-slate-800/80 rounded-2xl rounded-tl-sm p-4 w-[85%] border border-[var(--sky-border)]">
                                    <p className="text-sm text-slate-300">Are agencies required to use MFA for internal database access, or just external web portals?</p>
                                </div>
                                <div className="bg-sky-900/30 rounded-2xl rounded-tr-sm p-4 w-[90%] ml-auto border border-sky-500/20">
                                    <p className="text-sm text-slate-200 mb-2">Yes, MFA is required for all access to systems storing FTI.</p>
                                    <div className="pl-3 border-l-2 border-sky-500 mt-3 pt-1 pb-1">
                                        <p className="text-xs text-sky-400 font-medium">Source: Publication 1075, Section 9.3.1.5</p>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div className="order-1 lg:order-2">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
                                    <BrainCircuit className="h-6 w-6 text-indigo-400" />
                                </div>
                                <h2 className="text-indigo-400 font-semibold tracking-wide uppercase text-sm">Technical Inquiries</h2>
                            </div>
                            <h3 className="text-3xl font-bold tracking-tight text-white mb-6">The Subject Matter Expert AI</h3>
                            <p className="text-lg leading-relaxed text-[var(--sky-text-secondary)] mb-6">
                                The SkyShield Assistant acts as an instant subject matter expert. It eliminates the need to manually parse hundreds of pages of compliance documentation.
                            </p>
                            <ul className="space-y-4 text-[var(--sky-text-secondary)]">
                                <li className="flex items-start gap-3">
                                    <div className="mt-1 h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0"></div>
                                    <p><strong className="text-slate-200">Instant Answers:</strong> Resolve agency questions in seconds rather than routing through multiple queues.</p>
                                </li>
                                <li className="flex items-start gap-3">
                                    <div className="mt-1 h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0"></div>
                                    <p><strong className="text-slate-200">Mandatory Citations:</strong> The AI is strictly prompted to cite its sources, returning standard Pub 1075 section numbers for authoritative verification.</p>
                                </li>
                                <li className="flex items-start gap-3">
                                    <div className="mt-1 h-1.5 w-1.5 rounded-full bg-indigo-400 shrink-0"></div>
                                    <p><strong className="text-slate-200">Context Aware:</strong> Capable of analyzing complex, multi-system architectural scenarios against Safeguards requirements.</p>
                                </li>
                            </ul>
                        </div>
                    </div>
                </div>

                {/* Section 3: SCSEM Workflow */}
                <div className="mt-32 sm:mt-40 border-t border-[var(--sky-border)] pt-32 max-w-5xl mx-auto">
                    <div className="text-center mb-16">
                        <div className="flex justify-center items-center gap-3 mb-4">
                            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                                <FileSpreadsheet className="h-6 w-6 text-emerald-400" />
                            </div>
                            <h2 className="text-emerald-400 font-semibold tracking-wide uppercase text-sm">Automated Updates</h2>
                        </div>
                        <h3 className="text-3xl font-bold tracking-tight text-white sm:text-4xl mb-6">CIS Benchmark Integration</h3>
                        <p className="text-lg max-w-2xl mx-auto text-[var(--sky-text-secondary)]">
                            Maintaining the 58+ Safeguards Computer Security Evaluation Matrices (SCSEMs) is incredibly resource-intensive. SkyShield transforms this completely.
                        </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                        <div className="bg-slate-900/40 border border-[var(--sky-border)] p-8 rounded-2xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-4 opacity-10"><Zap className="w-24 h-24" /></div>
                            <div className="text-emerald-400 font-bold text-xl mb-4">1. Sync</div>
                            <h4 className="text-white font-medium mb-2">Monitor CIS</h4>
                            <p className="text-sm text-slate-400 leading-relaxed">SkyShield connects to security APIs to monitor when new CIS Benchmarks are released for technologies like Windows Server or Oracle.</p>
                        </div>
                        <div className="bg-slate-900/40 border border-[var(--sky-border)] p-8 rounded-2xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-4 opacity-10"><BrainCircuit className="w-24 h-24" /></div>
                            <div className="text-emerald-400 font-bold text-xl mb-4">2. Generate</div>
                            <h4 className="text-white font-medium mb-2">AI Payload Analysis</h4>
                            <p className="text-sm text-slate-400 leading-relaxed">The AI parses the new Benchmark, comparing it against the existing IRS SCSEM, and auto-generates exact proposed changes (NIST ID, Test ID, Criticality, and modified parameters).</p>
                        </div>
                        <div className="bg-slate-900/40 border border-[var(--sky-border)] p-8 rounded-2xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-4 opacity-10"><Users className="w-24 h-24" /></div>
                            <div className="text-emerald-400 font-bold text-xl mb-4">3. Review</div>
                            <h4 className="text-white font-medium mb-2">Human-in-the-Loop</h4>
                            <p className="text-sm text-slate-400 leading-relaxed">The Safeguards team views a clear diff side-by-side, quickly approving or rejecting the AI's proposed modifications before authoring the new official Excel file.</p>
                        </div>
                    </div>
                </div>

                {/* Section 4: Security Boundaries */}
                <div className="mt-32 sm:mt-40 border-t border-[var(--sky-border)] pt-32 max-w-5xl mx-auto mb-32">
                    <div className="bg-gradient-to-br from-slate-900 to-[#0B1121] border border-[var(--sky-border)] rounded-3xl p-8 sm:p-12 shadow-2xl relative overflow-hidden">
                        {/* Decorative background grid */}
                        <div className="absolute inset-0 bg-[url('/grid.svg')] bg-center [mask-image:linear-gradient(180deg,white,rgba(255,255,255,0))] opacity-10"></div>

                        <div className="relative z-10 grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
                            <div>
                                <div className="flex items-center gap-3 mb-4">
                                    <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20">
                                        <Lock className="h-6 w-6 text-red-400" />
                                    </div>
                                    <h2 className="text-red-400 font-semibold tracking-wide uppercase text-sm">Security Boundaries</h2>
                                </div>
                                <h3 className="text-3xl font-bold tracking-tight text-white mb-6">Zero-Trust Data Protection</h3>
                                <p className="text-lg leading-relaxed text-[var(--sky-text-secondary)] mb-6">
                                    Utilizing Generative AI within the Federal Government demands rigid boundaries. SkyShield implements strict Data Loss Prevention (DLP) locally.
                                </p>
                                <div className="space-y-4">
                                    <div className="flex gap-4">
                                        <div className="shrink-0 mt-1">
                                            <div className="w-8 h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
                                                <span className="text-xs font-bold text-slate-300">1</span>
                                            </div>
                                        </div>
                                        <div>
                                            <h4 className="text-white font-medium">Local Heuristic Scanning</h4>
                                            <p className="text-sm text-slate-400 mt-1 leading-relaxed">Before any prompt leaves the internal network to hit the LLM API, it is scanned locally via RegEx heuristics for PII and FTI signatures (SSNs, EINs, Bank Accts).</p>
                                        </div>
                                    </div>
                                    <div className="flex gap-4">
                                        <div className="shrink-0 mt-1">
                                            <div className="w-8 h-8 rounded-full bg-red-900/30 border border-red-500/30 flex items-center justify-center">
                                                <span className="text-xs font-bold text-red-400">2</span>
                                            </div>
                                        </div>
                                        <div>
                                            <h4 className="text-white font-medium">Hard Block & Incident Logging</h4>
                                            <p className="text-sm text-slate-400 mt-1 leading-relaxed">If sensitive data is detected, the request is hard-blocked. It never reaches the AI. The system automatically creates a high-priority entry in the Incident Management dashboard for review.</p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Visual Graphic Representation */}
                            <div className="bg-[#0f172a] rounded-xl border border-slate-800 p-6 shadow-inner relative">
                                <div className="absolute top-3 right-4 flex gap-1.5">
                                    <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                                    <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                                    <div className="w-2.5 h-2.5 rounded-full bg-slate-700"></div>
                                </div>
                                <div className="mt-6 space-y-3">
                                    <div className="border border-slate-700/50 bg-slate-800/50 p-3 rounded text-xs font-mono text-slate-300 leading-relaxed">
                                        {`> Incoming Query: "Does Agency X storing FTI for SSN ***-**-**** require 12 or 14 char pass..."`}
                                    </div>
                                    <div className="flex justify-center py-2">
                                        <Lock className="w-5 h-5 text-red-500 animate-pulse" />
                                    </div>
                                    <div className="border border-red-900/50 bg-red-950/30 p-3 rounded text-xs font-mono text-red-400 leading-relaxed">
                                        [BLOCK] SECURITY EXCEPTION OCCURRED: PII detected (TYPE: SSN). Request terminated. Incident INC-4002 generated.
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Section 5: The Bottom Line Benefits */}
                <div className="mt-32 sm:mt-40 border-t border-slate-800/50 pt-24 max-w-4xl mx-auto text-center">
                    <h3 className="text-3xl font-bold tracking-tight text-white mb-12">The Bottom Line</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-left">
                        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] p-6 rounded-xl hover:bg-slate-800/50 transition-colors">
                            <Clock className="w-8 h-8 text-sky-400 mb-4" />
                            <h4 className="text-lg font-semibold text-white mb-2">Hundreds of Hours Saved</h4>
                            <p className="text-sm text-[var(--sky-text-secondary)] leading-relaxed">
                                Currently, multiple levels of Quality Control (QC) and Quality Review (QR) spend hours tracking down specific NIST and Pub 1075 standards for inquiry tickets. SkyShield cuts research time to mere minutes.
                            </p>
                        </div>
                        <div className="bg-[var(--sky-surface)] border border-[var(--sky-border)] p-6 rounded-xl hover:bg-slate-800/50 transition-colors">
                            <BarChart3 className="w-8 h-8 text-sky-400 mb-4" />
                            <h4 className="text-lg font-semibold text-white mb-2">Radical Accuracy</h4>
                            <p className="text-sm text-[var(--sky-text-secondary)] leading-relaxed">
                                By heavily prompting the AI to only rely on official doctrine and return exact section citations, SkyShield drastically reduces human misinterpretation, bias, and conflicting guidance given to external agencies.
                            </p>
                        </div>
                    </div>

                    <div className="mt-24 pb-8">
                        <p className="text-slate-500 font-mono text-xs uppercase tracking-widest">Office of Safeguards • Internal System Validation</p>
                    </div>
                </div>

            </main>
        </div>
    );
}
