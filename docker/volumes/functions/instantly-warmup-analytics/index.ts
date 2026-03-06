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
  warmup_status: number;
  stat_warmup_score: number;
}

interface AccountsListResponse {
  items: InstantlyAccount[];
  next_starting_after?: string;
}

// Fetch all accounts from Instantly to check which emails exist
async function listInstantlyAccounts(): Promise<string[]> {
  const accounts: string[] = [];
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
    accounts.push(...(data.items || []).map((a) => a.email));
    cursor = data.next_starting_after;
    iterations++;

    // Rate limit protection
    if (cursor) await new Promise((r) => setTimeout(r, 200));
  } while (cursor && iterations < maxIterations);

  return accounts;
}

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, x-client-info, apikey",
        "Access-Control-Max-Age": "86400",
      },
    });
  }

  // Only allow POST
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Check API key is configured
  if (!INSTANTLY_API_KEY) {
    return new Response(
      JSON.stringify({ error: "Instantly API key not configured. Please set INSTANTLY_API_KEY secret." }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }

  try {
    const { emails } = await req.json();

    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      return new Response(
        JSON.stringify({ error: "emails array is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    console.log(`Processing ${emails.length} emails`);

    // Step 1: List all accounts in Instantly to find which emails exist
    console.log("Listing Instantly accounts...");
    const instantlyAccounts = await listInstantlyAccounts();
    console.log(`Found ${instantlyAccounts.length} accounts in Instantly`);

    // Find which requested emails exist in Instantly
    const emailsInInstantly = emails.filter((email) =>
      instantlyAccounts.some((acc) => acc.toLowerCase() === email.toLowerCase())
    );
    console.log(`${emailsInInstantly.length} of ${emails.length} emails found in Instantly`);

    // Step 2: Fetch warmup analytics for emails that exist
    const batchSize = 50;
    const allAggregateData: Record<string, WarmupMetrics> = {};
    const errors: string[] = [];

    if (emailsInInstantly.length > 0) {
      for (let i = 0; i < emailsInInstantly.length; i += batchSize) {
        const batch = emailsInInstantly.slice(i, i + batchSize);
        console.log(`Fetching analytics batch ${Math.floor(i / batchSize) + 1}: ${batch.length} emails`);

        try {
          const response = await fetch(
            "https://api.instantly.ai/api/v2/accounts/warmup-analytics",
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
