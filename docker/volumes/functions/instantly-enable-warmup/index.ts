// =============================================
// EDGE FUNCTION: instantly-enable-warmup
// =============================================
// Enables warmup for specified email accounts on Instantly.ai
// =============================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const INSTANTLY_API_KEY = Deno.env.get("INSTANTLY_API_KEY");

interface EnableWarmupRequest {
    emails: string[];
}

interface BackgroundJob {
    id: string;
    workspace_id: string;
    type: string;
    progress: number;
    status: "pending" | "in-progress" | "success" | "failed";
    created_at: string;
    updated_at: string;
}

Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 200,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
            },
        });
    }

    try {
        console.log("INSTANTLY_API_KEY configured:", !!INSTANTLY_API_KEY);
        
        if (!INSTANTLY_API_KEY) {
            console.error("INSTANTLY_API_KEY is not configured in Supabase secrets!");
            return new Response(
                JSON.stringify({ error: "INSTANTLY_API_KEY not configured" }),
                {
                    status: 500,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                }
            );
        }

        const { emails }: EnableWarmupRequest = await req.json();

        if (!emails || !Array.isArray(emails) || emails.length === 0) {
            return new Response(
                JSON.stringify({ error: "Missing or invalid emails array" }),
                {
                    status: 400,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                }
            );
        }

        console.log(`Enabling warmup for ${emails.length} emails...`);

        // Call Instantly API to enable warmup
        // API docs: https://developer.instantly.ai/api/v2/accounts/warmup/enable
        const response = await fetch(
            "https://api.instantly.ai/api/v2/accounts/warmup/enable",
            {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${INSTANTLY_API_KEY}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ emails }),
            }
        );

        if (response.status === 429) {
            console.warn("Rate limited by Instantly API");
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: "Rate limited. Please try again in a few seconds.",
                    enabled_count: 0
                }),
                {
                    status: 429,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                }
            );
        }

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`Instantly API error (${response.status}):`, errorText);
            
            let errorMessage = `Instantly API error: ${response.status}`;
            if (response.status === 401) {
                errorMessage = "Instantly API authentication failed. Check if INSTANTLY_API_KEY is valid and has correct scopes.";
            } else if (response.status === 403) {
                errorMessage = "Instantly API access forbidden. Check API key permissions.";
            }
            
            return new Response(
                JSON.stringify({ 
                    success: false, 
                    error: errorMessage,
                    details: errorText,
                    enabled_count: 0
                }),
                {
                    status: response.status,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                }
            );
        }

        const data: BackgroundJob = await response.json();
        console.log(`Warmup enable job created:`, data);

        return new Response(
            JSON.stringify({
                success: true,
                enabled_count: emails.length,
                job_id: data.id,
                job_status: data.status,
                message: `Warmup enable initiated for ${emails.length} email(s)`,
            }),
            {
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
            }
        );
    } catch (error) {
        console.error("Error:", error);
        return new Response(
            JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : "Internal server error",
                enabled_count: 0,
            }),
            {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                    "Access-Control-Allow-Origin": "*",
                },
            }
        );
    }
});
