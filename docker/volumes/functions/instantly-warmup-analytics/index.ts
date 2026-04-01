// =============================================
// EDGE FUNCTION: instantly-warmup-analytics
// =============================================
// Deploy this to your Supabase project:
// 1. Go to Edge Functions in Dashboard
// 2. Edit "instantly-warmup-analytics"
// 3. Replace all code with this
// 4. Deploy
// 5. Set secret: INSTANTLY_API_KEY
// =============================================

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const INSTANTLY_API_KEY = Deno.env.get("INSTANTLY_API_KEY");

interface WarmupMetrics {
    sent: number;
    landed_inbox: number;
    landed_spam: number;
    received: number;
    health_score?: number;
    health_score_label?: string;
}

interface WarmupAnalyticsResponse {
    email_date_data: Record<string, Record<string, WarmupMetrics>>;
    aggregate_data: Record<string, WarmupMetrics>;
}

interface InstantlyAccount {
    email: string;
    warmup_status: number; // 0 = disabled, 1 = enabled
    stat_warmup_score: number; // Health score from account (0-100)
}

interface AccountsListResponse {
    items: InstantlyAccount[];
    next_starting_after?: string;
}

// Account warmup data returned per email
interface AccountWarmupData {
    warmup_enabled: boolean; // warmup_status === 1
    warmup_score: number | null; // stat_warmup_score from account
}

// Fetch all accounts from Instantly with their warmup status and score
async function listInstantlyAccounts(): Promise<{ emails: string[]; accountData: Record<string, AccountWarmupData> }> {
    const emails: string[] = [];
    const accountData: Record<string, AccountWarmupData> = {};
    let cursor: string | undefined;
    let iterations = 0;
    const maxIterations = 10; // Safety limit

    do {
        const url = new URL("https://api.instantly.ai/api/v2/accounts");
        url.searchParams.set("limit", "100");
        if (cursor) url.searchParams.set("starting_after", cursor);

        const response = await fetch(url.toString(), {
            method: "GET",
            headers: {
                Authorization: `Bearer ${INSTANTLY_API_KEY}`,
            },
        });

        if (!response.ok) {
            console.error("Failed to list accounts:", await response.text());
            break;
        }

        const data: AccountsListResponse = await response.json();
        for (const account of data.items || []) {
            const emailLower = account.email.toLowerCase();
            emails.push(account.email);
            accountData[emailLower] = {
                warmup_enabled: account.warmup_status === 1,
                warmup_score: account.stat_warmup_score ?? null,
            };
        }

        cursor = data.next_starting_after;
        iterations++;
    } while (cursor && iterations < maxIterations);

    return { emails, accountData };
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
        const { emails } = await req.json();

        if (!emails || !Array.isArray(emails) || emails.length === 0) {
            return new Response(
                JSON.stringify({ error: "Missing or invalid emails array" }),
                {
                    status: 400,
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
                }
            );
        }

        console.log(`Processing ${emails.length} emails...`);

        // First get all accounts in Instantly with their warmup status and score
        const { emails: instantlyEmails, accountData } = await listInstantlyAccounts();
        console.log(`Found ${instantlyEmails.length} accounts in Instantly`);

        // Filter to only emails that exist in Instantly (case-insensitive)
        const instantlyEmailsLower = instantlyEmails.map(e => e.toLowerCase());
        const emailsInInstantly = emails.filter((email: string) =>
            instantlyEmailsLower.includes(email.toLowerCase())
        );

        console.log(`${emailsInInstantly.length} of ${emails.length} emails found in Instantly`);

        const allAggregateData: Record<string, WarmupMetrics> = {};
        const errors: string[] = [];

        if (emailsInInstantly.length > 0) {
            // Fetch warmup data in batches of 10
            const batchSize = 10;
            for (let i = 0; i < emailsInInstantly.length; i += batchSize) {
                const batch = emailsInInstantly.slice(i, i + batchSize);

                try {
                    const response = await fetch(
                        "https://api.instantly.ai/api/v2/accounts/warmup/analytics",
                        {
                            method: "POST",
                            headers: {
                                Authorization: `Bearer ${INSTANTLY_API_KEY}`,
                                "Content-Type": "application/json",
                            },
                            body: JSON.stringify({ emails: batch }),
                        }
                    );

                    if (response.status === 429) {
                        console.warn("Rate limited, waiting...");
                        errors.push("Rate limited - some data may be incomplete");
                        await new Promise((r) => setTimeout(r, 10000));
                        i -= batchSize; // Retry
                        continue;
                    }

                    if (!response.ok) {
                        console.error(`API error (${response.status}):`, await response.text());
                        continue;
                    }

                    const data: WarmupAnalyticsResponse = await response.json();
                    if (data.aggregate_data) {
                        Object.assign(allAggregateData, data.aggregate_data);
                    }
                } catch (batchError) {
                    console.error("Batch error:", batchError);
                }

                if (i + batchSize < emailsInInstantly.length) {
                    await new Promise((r) => setTimeout(r, 200));
                }
            }
        }

        const matchedWithData = Object.keys(allAggregateData).length;
        console.log(`Completed: ${emailsInInstantly.length} in Instantly, ${matchedWithData} with warmup data`);

        return new Response(
            JSON.stringify({
                aggregate_data: allAggregateData,
                account_data: accountData, // Includes warmup_enabled and warmup_score per email
                emails_in_instantly: emailsInInstantly,
                matched_count: matchedWithData,
                found_in_instantly: emailsInInstantly.length,
                total_requested: emails.length,
                errors: errors.length > 0 ? errors : undefined,
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
                error: error instanceof Error ? error.message : "Internal server error",
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
