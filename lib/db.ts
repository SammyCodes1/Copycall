import "server-only";
/**
 * Server-only Supabase client using the service-role key.
 *
 * The service-role key bypasses RLS, so this module must never be imported by
 * a client component ("server-only" makes that a build error). The browser
 * never talks to Supabase directly (security addendum B); every read/write of
 * user data goes through an API route that checks the session first.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireEnv } from "./env";

let client: SupabaseClient | null = null;

export function getDb(): SupabaseClient {
  if (client) return client;
  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "copycall-server" } },
  });
  return client;
}
