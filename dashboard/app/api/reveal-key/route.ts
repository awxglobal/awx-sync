import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function POST() {
  const config = readConfig();
  if (!config) {
    return NextResponse.json({ error: "no_config", message: "Not logged in." }, { status: 400 });
  }

  try {
    const res = await fetch(`${config.apiUrl}/auth/rotate-key`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      cache: "no-store",
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown" }));
      return NextResponse.json(
        { error: "backend_error", message: err.error ?? `Backend returned ${res.status}` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json({ api_key: data.api_key, message: data.message });
  } catch (error) {
    return NextResponse.json(
      { error: "backend_unreachable", message: (error as Error).message },
      { status: 502 }
    );
  }
}
