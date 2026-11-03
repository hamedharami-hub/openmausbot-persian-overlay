/** Independent DOM observation after a successful browser read, not identical read bytes or proof of understanding. */
export interface ResearchContentReceipt {
  version: 1;
  source: "agent-browser-dom";
  url: string;
  observedAt: number;
  contentHash: string;
  capturedChars: number;
  truncated: boolean;
  hashBasis: "scrubbed-dom-visible-text";
  requestedUrl: null;
  /** Page-reported metadata only; not factually verified dates. */
  publishedAt?: string;
  /** Page-reported metadata only; not factually verified dates. */
  modifiedAt?: string;
}
