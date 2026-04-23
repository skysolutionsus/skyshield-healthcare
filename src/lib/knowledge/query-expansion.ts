const CONTROL_PATTERN = /\b(?:AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d+(?:\([^)]+\))?\b/gi;

interface SynonymGroup {
  triggers: RegExp;
  expand: string[];
}

const SYNONYM_GROUPS: SynonymGroup[] = [
  {
    triggers: /\b(encrypt(?:ion|ed)?|cryptographic|at\s*rest|stored\s*data|data\s*at\s*rest|fips\s*140|aes[- ]?256|tde)\b/i,
    expand: ["SC-28", "SC-13", "FIPS 140-2", "cryptographic protection", "protection of information at rest"],
  },
  {
    triggers: /\b(in\s*transit|in-?transit|tls|ssl|https|transport|vpn|ipsec)\b/i,
    expand: ["SC-8", "SC-8(1)", "SC-12", "SC-13", "transmission confidentiality", "transmission integrity"],
  },
  {
    triggers: /\b(authentication|authenticator|password|passphrase|credential|mfa|multi[- ]?factor|2fa|piv|cac|login)\b/i,
    expand: ["IA-2", "IA-5", "IA-5(1)", "IA-8", "identification and authentication", "authenticator management"],
  },
  {
    triggers: /\b(account|provisioning|deprovision|termination|onboard|offboard|least\s*privilege|privileged\s*access)\b/i,
    expand: ["AC-2", "AC-5", "AC-6", "account management", "separation of duties"],
  },
  {
    triggers: /\b(access\s*control|authorization|rbac|role[- ]?based)\b/i,
    expand: ["AC-3", "AC-6", "AC-24", "access enforcement"],
  },
  {
    triggers: /\b(remote\s*access|telework|vpn\s*user|remote\s*worker|work\s*from\s*home)\b/i,
    expand: ["AC-17", "AC-17(1)", "AC-17(2)", "remote access"],
  },
  {
    triggers: /\b(mobile|laptop|tablet|byod|portable)\b/i,
    expand: ["AC-19", "MP-5", "access control for mobile devices"],
  },
  {
    triggers: /\b(media|removable|usb|thumb\s*drive|backup\s*tape|disposal|sanitiz)\b/i,
    expand: ["MP-4", "MP-5", "MP-6", "MP-7", "media protection", "media sanitization"],
  },
  {
    triggers: /\b(audit\s*log|logging|monitor(?:ing)?|siem|security\s*event|event\s*log)\b/i,
    expand: ["AU-2", "AU-3", "AU-6", "AU-12", "audit events"],
  },
  {
    triggers: /\b(incident|breach|unauthorized\s*disclosure|data\s*leak|lost\s*laptop|lost\s*media)\b/i,
    expand: ["IR-4", "IR-6", "IR-8", "incident handling", "incident reporting", "Section 10"],
  },
  {
    triggers: /\b(background\s*check|personnel\s*screening|suitability|clearance)\b/i,
    expand: ["PS-3", "personnel screening"],
  },
  {
    triggers: /\b(configuration|baseline|hardening|stig|cis\s*benchmark)\b/i,
    expand: ["CM-2", "CM-6", "baseline configuration", "configuration settings"],
  },
  {
    triggers: /\b(vulnerability|patch|scan|flaw)\b/i,
    expand: ["RA-5", "SI-2", "vulnerability scanning", "flaw remediation"],
  },
  {
    triggers: /\b(contingency|continuity|disaster\s*recovery|backup\s*plan|cop|bcp|drp)\b/i,
    expand: ["CP-2", "CP-9", "CP-10", "contingency planning"],
  },
  {
    triggers: /\b(physical|facility|data\s*center|server\s*room|visitor)\b/i,
    expand: ["PE-2", "PE-3", "PE-6", "physical access control"],
  },
  {
    triggers: /\b(cloud|aws|azure|gcp|saas|iaas|paas|fedramp)\b/i,
    expand: ["SA-9", "SC-7", "Section 4.7", "cloud computing", "FedRAMP"],
  },
  {
    triggers: /\b(fti|federal\s*tax\s*information|safeguards|disclosure)\b/i,
    expand: ["Federal Tax Information", "FTI", "Publication 1075", "disclosure"],
  },
  {
    triggers: /\b(sdn|network\s*segmentation|firewall|boundary|dmz)\b/i,
    expand: ["SC-7", "SC-7(3)", "boundary protection"],
  },
  {
    triggers: /\b(data\s*warehouse|database|dbms|sql|mysql|oracle|postgres)\b/i,
    expand: ["Section 9.4", "AC-3", "AU-2", "database"],
  },
  {
    triggers: /\b(training|awareness|security\s*training)\b/i,
    expand: ["AT-2", "AT-3", "security awareness training"],
  },
];

export interface QueryExpansion {
  originalQuery: string;
  expandedQuery: string;
  extractedControls: string[];
  addedTerms: string[];
}

export function expandQuery(query: string): QueryExpansion {
  const added = new Set<string>();
  const controls = new Set<string>();

  const controlMatches = query.match(CONTROL_PATTERN) || [];
  for (const match of controlMatches) {
    controls.add(match.toUpperCase());
  }

  for (const group of SYNONYM_GROUPS) {
    if (group.triggers.test(query)) {
      for (const term of group.expand) {
        if (!query.toLowerCase().includes(term.toLowerCase())) {
          added.add(term);
        }
        const controlHit = term.match(CONTROL_PATTERN);
        if (controlHit) controlHit.forEach((c) => controls.add(c.toUpperCase()));
      }
    }
  }

  const addedTerms = [...added];
  const expandedQuery =
    addedTerms.length > 0 ? `${query}\n\nRelated controls and phrasing: ${addedTerms.join(", ")}` : query;

  return {
    originalQuery: query,
    expandedQuery,
    extractedControls: [...controls],
    addedTerms,
  };
}
