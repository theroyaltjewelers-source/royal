/* Public configuration for the ROYAL web app.  Nothing secret belongs here:
   the anon key is designed to be public, and every protected action is
   checked on the server. */
window.ROYAL_CONFIG = {
  API: "",                       /* same origin by default */
  IDENTITY_URL: "",              /* the calculator's Supabase URL, e.g. https://xxxx.supabase.co */
  IDENTITY_ANON_KEY: "",         /* the calculator's Supabase anon key */
  DEV: location.hostname === "localhost" || location.hostname === "127.0.0.1",
};
