/** Zoho config — mirrors eat-os/app/config.py. READ-ONLY usage in v1. */
export const zohoConfig = {
  get dc() {
    return process.env.ZOHO_DC || "in";
  },
  get orgId() {
    return process.env.ZOHO_ORG_ID || "";
  },
  get clientId() {
    return process.env.ZOHO_CLIENT_ID || "";
  },
  get clientSecret() {
    return process.env.ZOHO_CLIENT_SECRET || "";
  },
  get refreshToken() {
    return process.env.ZOHO_REFRESH_TOKEN || "";
  },
  get enabled() {
    return (
      process.env.ZOHO_ENABLED === "true" &&
      !!this.orgId &&
      !!this.clientId &&
      !!this.clientSecret &&
      !!this.refreshToken
    );
  },
  get accountsBase() {
    return `https://accounts.zoho.${this.dc}`;
  },
  get inventoryBase() {
    return `https://www.zohoapis.${this.dc}/inventory/v1`;
  },
  get booksBase() {
    return `https://www.zohoapis.${this.dc}/books/v3`;
  },
};

export class ZohoNotConfiguredError extends Error {
  constructor() {
    super(
      "Zoho is not configured. Set ZOHO_ENABLED=true and ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN/ORG_ID (reuse eat-os EATOS_ZOHO_* values).",
    );
    this.name = "ZohoNotConfiguredError";
  }
}

export class ZohoApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ZohoApiError";
  }
}
