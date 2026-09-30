/* Public configuration for the ROYAL web app.  Nothing secret belongs here:
   the anon key is designed to be public, and every protected action is
   checked on the server. */
window.ROYAL_CONFIG = {
  API: "",                       /* same origin by default */
  IDENTITY_URL: "https://udfwjoyhecxybktjnvoo.supabase.co",  /* the calculator's Supabase project */
  IDENTITY_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkZndqb3loZWN4eWJrdGpudm9vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAwOTE1ODksImV4cCI6MjEwNTY2NzU4OX0.wY6xFlIlCLeZsh9bwHun5rIRPDzTVWDOGkhgA-WVWb8",  /* public anon key, same as the calculator's */
  DEV: location.hostname === "localhost" || location.hostname === "127.0.0.1",
};
