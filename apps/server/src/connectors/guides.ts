/**
 * How to connect each source, shown on the Connections page (and the admin's part under
 * Platform admin → Credentials). The step-by-step instructions for API keys and tokens live
 * on each connector's `tokenConnect`; these guides add the overview, what you need, the
 * one-click sign-in steps, how a platform administrator enables one-click sign-in, and
 * troubleshooting. `{redirectUri}` is replaced with this platform's callback URL.
 */
export interface ConnectorGuide {
  /** One or two sentences: which way to connect and why. */
  summary: string;
  /** What the user needs before starting. */
  needs: string[];
  /** Steps when one-click sign-in is available. */
  signIn?: string[];
  /** What a platform administrator does once to enable one-click sign-in for everyone. */
  adminSetup?: string[];
  troubleshooting?: string[];
  links?: { label: string; url: string }[];
}

const metaAdmin = (perms: string) => [
  "At developers.facebook.com → My Apps → Create app, choose “Other” → “Business” and link it to your Business portfolio.",
  "App settings → Basic: add this site's domain under App domains, then “+ Add platform” → Website with this site's address as Site URL, and save (otherwise Facebook says the domain isn't included in the app's domains).",
  "Add the “Facebook Login for Business” product. Under its Settings add {redirectUri} as a Valid OAuth Redirect URI (add the Pages and Instagram redirect URLs too to use one app for all three).",
  "Facebook Login for Business → Configurations → Create configuration: choose “User access token”, tick ads_read, business_management, pages_show_list, pages_read_engagement, read_insights, instagram_basic and instagram_manage_insights, and copy the Configuration ID.",
  "Copy the App ID and App secret (App settings → Basic) and paste them here with the Configuration ID.",
  `That's enough for you and anyone with a role on the app (App roles → add teammates) to sign in right away. To let outside customers sign in, request Advanced access for ${perms} under App Review and switch the app to Live.`,
];

const googleAdmin = (api: string, scope: string) => [
  `In Google Cloud (console.cloud.google.com) create a project and enable the ${api} (APIs & Services → Library).`,
  "APIs & Services → OAuth consent screen (Google Auth Platform): choose External, fill in the app name and support email, then under Audience click “Publish app” (In production). In Testing mode Google expires sign-ins after 7 days.",
  `Under Data access add the scope ${scope}. Until Google verifies the app, sign-in shows “Google hasn't verified this app” — click Advanced → Continue; it works for up to 100 users meanwhile.`,
  "APIs & Services → Credentials → Create credentials → OAuth client ID → Web application. Add the redirect URL(s) shown here as Authorized redirect URIs.",
  "Copy the client ID and client secret and paste them here. The same client serves GA4, Search Console, Google Ads and Sheets.",
];

export const GUIDES: Record<string, ConnectorGuide> = {
  shopify: {
    summary: "Connect with an Admin API access token from a custom app in your store (works right away), or with one-click sign-in if your administrator has set up the Shopify app.",
    needs: ["Store owner or staff with permission to develop apps", "Your store's myshopify.com domain"],
    signIn: ["Click Continue to Shopify and enter your store domain (your-store.myshopify.com).", "Approve the read-only permissions in Shopify.", "Choose the store to sync — the import starts immediately."],
    adminSetup: [
      "Create an app in the Shopify Dev Dashboard (dev.shopify.com) or a Partner account.",
      "Set the App URL to this site and add {redirectUri} as an allowed redirection URL.",
      "Request the read_orders, read_products and read_inventory scopes (read_all_orders needs Shopify's approval for history beyond 60 days).",
      "Copy the Client ID and Client secret into Platform admin → Credentials → Shopify.",
    ],
    troubleshooting: ["“Missing scope” — edit the custom app's Admin API scopes, reinstall it and copy the new token.", "Only the last 60 days of orders imported — Shopify limits history unless read_all_orders is granted."],
    links: [{ label: "Shopify: custom apps", url: "https://help.shopify.com/en/manual/apps/app-types/custom-apps" }],
  },
  woocommerce: {
    summary: "Connect with a read-only REST API key generated in WooCommerce. Your store must be reachable over HTTPS.",
    needs: ["WordPress admin access with WooCommerce", "Store URL (https://…)", "Permalinks not set to “Plain”"],
    troubleshooting: ["401 / “rejected the key” — some hosts strip the Authorization header; ask the host to allow it or use a security plugin setting that passes it through.", "404 on /wp-json — set Settings → Permalinks to anything other than Plain."],
    links: [{ label: "WooCommerce REST API keys", url: "https://woocommerce.com/document/woocommerce-rest-api/" }],
  },
  stripe: {
    summary: "Connect with a restricted API key that has read access. No sign-in or admin setup needed.",
    needs: ["Stripe account Administrator or Developer role"],
    troubleshooting: ["Some figures missing — the restricted key lacks Read access for that resource (Balance, Customers, Subscriptions…). Edit the key in Stripe; the next sync fills them in."],
    links: [{ label: "Stripe: restricted keys", url: "https://docs.stripe.com/keys#limit-access" }],
  },
  ga4: {
    summary: "Connect with a Google service-account key (recommended without sign-in: you grant it Viewer access to your property), your own Google OAuth client, or one-click Google sign-in once your administrator has set it up.",
    needs: ["Editor or Administrator on the GA4 property (to add the service account as a Viewer)", "A Google Cloud project (free)"],
    signIn: ["Click Continue to Google Analytics 4 and sign in with a Google account that can see the property.", "Approve read-only Analytics access.", "Choose the properties to sync."],
    adminSetup: googleAdmin("Google Analytics Data API and Google Analytics Admin API", "https://www.googleapis.com/auth/analytics.readonly"),
    troubleshooting: ["“Can't see any GA4 property” — add the service account email under GA4 Admin → Property access management as Viewer and wait a minute.", "“API has not been used in project” — enable both Analytics APIs in the same Google Cloud project as the key."],
    links: [{ label: "Google Cloud: service account keys", url: "https://cloud.google.com/iam/docs/keys-create-delete" }, { label: "GA4: add users", url: "https://support.google.com/analytics/answer/9305788" }],
  },
  gsc: {
    summary: "Connect with a Google service-account key added as a user of your Search Console property, your own Google OAuth client, or one-click Google sign-in once your administrator has set it up.",
    needs: ["Owner of the Search Console property (to add users)", "A Google Cloud project (free)"],
    signIn: ["Click Continue to Google Search Console and sign in with a Google account that has access to the property.", "Approve read-only Search Console access.", "Choose the properties to sync."],
    adminSetup: googleAdmin("Google Search Console API", "https://www.googleapis.com/auth/webmasters.readonly"),
    troubleshooting: ["No properties listed — add the service account email in Search Console → Settings → Users and permissions.", "Figures 2–3 days behind — that's how Search Console publishes final data."],
    links: [{ label: "Search Console: add users", url: "https://support.google.com/webmasters/answer/7687615" }],
  },
  google_ads: {
    summary: "Connect with your own developer token and Google OAuth client (from a Google Ads manager account), or one-click Google sign-in once your administrator has set it up with an approved developer token.",
    needs: ["A Google Ads manager (MCC) account linked to your ad account", "A developer token with Explorer or Basic access", "A Google Cloud project (free)"],
    signIn: ["Click Continue to Google Ads and sign in with a Google account that has access to the ad accounts.", "Approve Google Ads access.", "Choose the ad accounts to sync."],
    adminSetup: [
      ...googleAdmin("Google Ads API", "https://www.googleapis.com/auth/adwords"),
      "Developer token: in a Google Ads manager account (free) open Tools → API Center, accept the terms and copy the token. Apply there for Explorer or Basic access — until Google approves it, the token only reaches test accounts.",
    ],
    troubleshooting: ["“Developer token isn't approved” — a new token only works with test accounts; apply for Explorer/Basic access in API Center.", "Accounts missing — the Google user who created the refresh token must have access to them (directly or through the manager account)."],
    links: [{ label: "Google Ads API: developer token", url: "https://developers.google.com/google-ads/api/docs/api-policy/developer-token" }, { label: "OAuth 2.0 Playground", url: "https://developers.google.com/oauthplayground" }],
  },
  meta_ads: {
    summary: "Connect with a system-user access token from Meta Business Settings (doesn't expire), or one-click Facebook sign-in once your administrator has set up a Meta app.",
    needs: ["Admin of the Meta Business portfolio that owns the ad accounts", "A Meta app (developers.facebook.com → Create app → Business) — needed to generate the token"],
    signIn: ["Click Continue to Meta Ads and log in with Facebook.", "Choose the ad accounts and approve ads_read.", "Choose the ad accounts to sync."],
    adminSetup: metaAdmin("ads_read and business_management"),
    troubleshooting: ["Token rejected after ~60 days — you used a user token; generate a system-user token instead.", "Ad account missing — assign it to the system user (Business Settings → System users → Assign assets)."],
    links: [{ label: "Meta: system users", url: "https://www.facebook.com/business/help/503306463479099" }],
  },
  facebook_pages: {
    summary: "Connect with a system-user access token that has access to your Pages, or one-click Facebook sign-in once your administrator has set up a Meta app.",
    needs: ["Admin of the Business portfolio that owns the Pages", "A Meta app (developers.facebook.com → Create app → Business)"],
    signIn: ["Click Continue to Facebook Pages and log in with Facebook.", "Pick the Pages and approve read access to insights.", "Choose the Pages to sync."],
    adminSetup: metaAdmin("pages_show_list, pages_read_engagement and read_insights"),
    troubleshooting: ["Some metrics missing — Meta is retiring several Page Insights metrics; the connector falls back to their replacements where they exist."],
  },
  instagram: {
    summary: "Connect with a system-user access token covering the Facebook Pages linked to your Instagram professional accounts, or one-click Facebook sign-in once your administrator has set up a Meta app.",
    needs: ["An Instagram business or creator account linked to a Facebook Page", "Admin of the Business portfolio", "A Meta app (developers.facebook.com → Create app → Business)"],
    signIn: ["Click Continue to Instagram and log in with Facebook (Instagram professional accounts are managed through their linked Page).", "Approve Instagram insights access.", "Choose the accounts to sync."],
    adminSetup: metaAdmin("instagram_basic, instagram_manage_insights, pages_show_list and pages_read_engagement"),
    troubleshooting: ["No Instagram accounts found — in Instagram settings switch to a professional account and link it to a Facebook Page in Meta Business Suite."],
  },
  tiktok_ads: {
    summary: "Connect with a long-term access token from your TikTok for Business developer app, or one-click sign-in once your administrator has set up the app.",
    needs: ["A TikTok for Business developer account and app (business-api.tiktok.com)", "Admin or Operator access to the advertiser accounts"],
    signIn: ["Click Continue to TikTok Ads and sign in with TikTok for Business.", "Select the advertiser accounts and approve read-only reporting access.", "Choose the accounts to sync."],
    adminSetup: [
      "At business-api.tiktok.com → My Apps create an app and request the Ad Account Management and Reporting permissions (TikTok reviews new apps).",
      "Set the Advertiser redirect URL to {redirectUri}.",
      "Copy the App ID and Secret into Platform admin → Credentials → TikTok Ads.",
    ],
    troubleshooting: ["Code 40105 / reconnect needed — the token was revoked; authorize again to get a new one."],
    links: [{ label: "TikTok API for Business: authorization", url: "https://business-api.tiktok.com/portal/docs?id=1738373164380162" }],
  },
  linkedin_ads: {
    summary: "Connect with an access token from LinkedIn's token generator (lasts 60 days), or one-click LinkedIn sign-in once your administrator has set up an app with the Advertising API.",
    needs: ["A LinkedIn developer app with the Advertising API product", "Viewer (or higher) role on the ad accounts in Campaign Manager"],
    signIn: ["Click Continue to LinkedIn Ads and sign in with LinkedIn.", "Approve read-only ads reporting.", "Choose the ad accounts to sync."],
    adminSetup: [
      "At linkedin.com/developers create an app linked to your company Page and request the Advertising API product (LinkedIn reviews the request).",
      "Under Auth add {redirectUri} as an Authorized redirect URL; the app needs r_ads and r_ads_reporting.",
      "Copy the Client ID and Client secret into Platform admin → Credentials → LinkedIn Ads.",
    ],
    troubleshooting: ["Stops working after 60 days — generated tokens expire; create a new one (or ask your administrator to enable sign-in, which refreshes automatically)."],
  },
  hubspot: {
    summary: "Connect with a private app access token from your HubSpot account, or one-click sign-in once your administrator has set up the HubSpot app.",
    needs: ["HubSpot Super Admin (to create private apps)"],
    signIn: ["Click Continue to HubSpot and choose the HubSpot account.", "Approve read access to contacts and deals.", "The account is selected automatically; the import starts."],
    adminSetup: [
      "In a HubSpot developer account create a public app (Apps → Create app).",
      "Under Auth add {redirectUri} as a Redirect URL and add the scopes crm.objects.contacts.read and crm.objects.deals.read.",
      "Copy the Client ID and Client secret into Platform admin → Credentials → HubSpot.",
    ],
  },
  salesforce: {
    summary: "Connect with your own connected app's consumer key and secret (Client Credentials flow), or one-click Salesforce sign-in once your administrator has set up a connected app.",
    needs: ["Salesforce System Administrator (to create a connected app)", "An edition with API access (Enterprise, Unlimited, Developer or Performance)"],
    signIn: ["Click Continue to Salesforce (enter your My Domain or sandbox login URL if you don't use login.salesforce.com).", "Log in and approve API access.", "Choose the org to sync."],
    adminSetup: [
      "In Salesforce Setup → App Manager → New Connected App (or External Client App), enable OAuth settings.",
      "Set the Callback URL to {redirectUri} and select the scopes api and refresh_token (offline_access). Require PKCE.",
      "After saving, copy the Consumer key and secret (Manage Consumer Details) into Platform admin → Credentials → Salesforce.",
    ],
    troubleshooting: ["“invalid_client” — Client Credentials Flow isn't enabled or the Run As user isn't set on the connected app's policies."],
  },
  gohighlevel: {
    summary: "Connect with a Private Integration token from your sub-account. No sign-in or admin setup needed.",
    needs: ["Admin access to the GoHighLevel sub-account (location)", "The Location ID"],
  },
  klaviyo: {
    summary: "Connect with a read-only private API key. No sign-in or admin setup needed.",
    needs: ["Klaviyo Owner, Admin or Manager role"],
  },
  mailchimp: {
    summary: "Connect with a Mailchimp API key. No sign-in or admin setup needed. Each audience becomes an account you can choose to sync.",
    needs: ["Mailchimp account access"],
  },
  brevo: {
    summary: "Connect with a Brevo API key (v3, starts with xkeysib-). No sign-in or admin setup needed.",
    needs: ["Brevo admin access"],
    troubleshooting: ["“Unauthorized IP” — turn off IP restriction for API keys under Security → Authorised IPs, or add this platform's servers."],
  },
  zendesk: {
    summary: "Connect with an API token plus the email of an agent or admin. No sign-in or admin setup needed.",
    needs: ["Zendesk admin (to create API tokens)", "Your subdomain (the “acme” in acme.zendesk.com)"],
  },
  intercom: {
    summary: "Connect with an access token from a private app in the Intercom Developer Hub. No sign-in or admin setup needed.",
    needs: ["Intercom workspace admin", "Your data region (US, EU or Australia)"],
  },
  quickbooks: {
    summary: "Connect with your own Intuit app (client ID, secret and a refresh token from Intuit's OAuth Playground), or one-click sign-in once your administrator has set up the platform's Intuit app.",
    needs: ["QuickBooks Online admin", "A free Intuit Developer account (developer.intuit.com)", "The company's Realm ID"],
    signIn: ["Click Continue to QuickBooks Online and sign in with Intuit.", "Pick the company and approve read access to accounting data.", "The company is selected automatically; the import starts."],
    adminSetup: [
      "At developer.intuit.com create an app with the QuickBooks Online Accounting scope (com.intuit.quickbooks.accounting).",
      "Under Production → Keys and credentials complete Intuit's app assessment, then add {redirectUri} as a Redirect URI.",
      "Copy the production Client ID and Client secret into Platform admin → Credentials → QuickBooks Online (set Environment to “sandbox” only for testing with development keys).",
    ],
    troubleshooting: ["“Can't open company” — the Realm ID or environment doesn't match the keys (sandbox keys only reach sandbox companies).", "Reconnect needed after 100+ days offline — Intuit refresh tokens expire if unused; syncs normally keep them alive."],
  },
  xero: {
    summary: "Connect with a Xero Custom Connection (client ID and secret; Xero charges a small monthly fee for custom connections), or one-click Xero sign-in once your administrator has set up a Xero app.",
    needs: ["Xero organisation admin (Adviser role)", "A Xero developer account (developer.xero.com)"],
    signIn: ["Click Continue to Xero and log in.", "Choose the organisations to allow and approve read-only access.", "Choose the organisations to sync."],
    adminSetup: [
      "At developer.xero.com → My Apps → New app choose Web app and set the Redirect URI to {redirectUri}.",
      "Use the scopes offline_access, accounting.settings.read and accounting.journals.read.",
      "Copy the Client ID and generate a Client secret, then add them under Platform admin → Credentials → Xero.",
    ],
  },
  google_sheets: {
    summary: "Connect a sheet by its “Publish to web” CSV link (simplest), privately with a Google service-account key you share the sheet with, or with one-click Google sign-in once your administrator has set it up.",
    needs: ["A sheet laid out with a date column and one column per metric (see the CSV template)"],
    signIn: ["Paste the spreadsheet link (and optionally the tab name), then click Continue to Google Sheets.", "Sign in with a Google account that can open the sheet and approve read-only access.", "The sheet is read on every sync."],
    adminSetup: googleAdmin("Google Sheets API", "https://www.googleapis.com/auth/spreadsheets.readonly"),
    troubleshooting: ["Columns ignored — headers must match a metric's name or key (download the CSV template for the list).", "Dates rejected — use YYYY-MM-DD."],
  },
  csv: {
    summary: "Upload a CSV file with one row per day. Upload a new file whenever you want to update the figures.",
    needs: ["A CSV file: a “date” column (YYYY-MM-DD) and one column per metric — download the template for the exact column names"],
    signIn: [
      "Click Upload CSV and download the template to see every supported column.",
      "Fill in one row per day (empty cells mean “no data”, not zero). Add a “currency” column if money isn't in your business currency.",
      "Choose the file and click Upload. Re-upload later with “Upload new file” — the new file replaces the old one.",
    ],
  },
};

export function guideFor(id: string, redirectUri: string): ConnectorGuide | null {
  const g = GUIDES[id];
  if (!g) return null;
  const fill = (list?: string[]) => list?.map((s) => s.replaceAll("{redirectUri}", redirectUri));
  return { ...g, signIn: fill(g.signIn), adminSetup: fill(g.adminSetup), troubleshooting: fill(g.troubleshooting) };
}
