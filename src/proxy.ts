import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Optimistic auth gate + Supabase session refresh. The real authorization
 * check happens server-side in every page and API route (getOrgContext); this
 * only redirects obviously signed-out visitors and keeps Supabase cookies fresh.
 */
const PUBLIC = [/^\/login/, /^\/signup/, /^\/api\/auth\//, /^\/api\/n8n\/callback\//, /^\/api\/health/, /^\/api\/integrations\/gmail\/callback/];

function supabaseMode() {
  const mode = process.env.AUTH_MODE;
  if (mode) return mode === "supabase";
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

// Mirrors env(): no DATABASE_URL means the embedded database and no sign-in.
function noAuthMode() {
  return process.env.AUTH_MODE === "none" || (!process.env.AUTH_MODE && !process.env.DATABASE_URL?.trim());
}

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC.some((re) => re.test(path));
  let response = NextResponse.next({ request });
  let signedIn = false;

  if (noAuthMode()) {
    signedIn = true;
  } else if (supabaseMode()) {
    const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    });
    const { data } = await supabase.auth.getClaims();
    signedIn = Boolean(data?.claims?.sub);
  } else {
    signedIn = Boolean(request.cookies.get("ad_session")?.value);
  }

  if (!signedIn && !isPublic) {
    if (path.startsWith("/api/")) {
      return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Please sign in to continue." } }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = path === "/" ? "" : `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }
  if (signedIn && (path === "/login" || path === "/signup")) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|samples/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|csv)$).*)"],
};
