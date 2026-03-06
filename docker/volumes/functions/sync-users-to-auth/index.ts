import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  // Handle CORS
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    // Get Supabase client with service role (automatically available in Edge Functions)
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (!supabaseUrl || !supabaseServiceKey) {
      return new Response(
        JSON.stringify({ error: 'Missing Supabase configuration' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // Get all users from public.users
    const { data: usersToSync, error: queryError } = await supabaseAdmin
      .from('users')
      .select('id, email, full_name, role, organization_id')
      .order('created_at', { ascending: false });

    if (queryError) {
      throw queryError;
    }

    if (!usersToSync || usersToSync.length === 0) {
      return new Response(
        JSON.stringify({ message: 'No users to sync', synced: 0 }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    // Check which users already exist in auth.users
    const existingIds = new Set<string>();
    const existingEmails = new Set<string>();

    for (const user of usersToSync) {
      try {
        // Try to get user by ID
        const { data: authUserById } = await supabaseAdmin.auth.admin.getUserById(user.id);
        if (authUserById?.user) {
          existingIds.add(user.id);
          if (authUserById.user.email) {
            existingEmails.add(authUserById.user.email.toLowerCase());
          }
          continue;
        }
      } catch (err) {
        // User doesn't exist by ID, continue checking
      }

      // Try to get user by email (if email is valid)
      if (user.email && user.email.includes('@')) {
        try {
          const { data: authUserByEmail } = await supabaseAdmin.auth.admin.getUserByEmail(user.email);
          if (authUserByEmail?.user) {
            existingIds.add(authUserByEmail.user.id);
            existingEmails.add(user.email.toLowerCase());
          }
        } catch (err) {
          // User doesn't exist by email, continue
        }
      }
    }

    // Filter users that need to be created
    const usersToCreate = usersToSync.filter(
      (user: any) =>
        !existingIds.has(user.id) &&
        (!user.email || !existingEmails.has(user.email?.toLowerCase()))
    );

    if (usersToCreate.length === 0) {
      return new Response(
        JSON.stringify({
          message: 'All users already exist in auth.users',
          synced: 0,
          total: usersToSync.length,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
      );
    }

    // Create users in auth.users using Admin API
    const results: any[] = [];
    const errors: any[] = [];

    for (const user of usersToCreate) {
      try {
        // Skip users with invalid emails
        if (!user.email || !user.email.includes('@') || !user.email.includes('.')) {
          errors.push({
            email: user.email || 'N/A',
            error: 'Invalid email address',
          });
          continue;
        }

        // Generate a temporary password
        const tempPassword = `TempPass${Math.random().toString(36).slice(-12)}!`;

        const { data: authUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
          id: user.id, // Use the same ID from public.users
          email: user.email,
          password: tempPassword,
          email_confirm: true, // Auto-confirm since these are existing users
          user_metadata: {
            full_name: user.full_name,
            role: user.role,
          },
          app_metadata: {
            organization_id: user.organization_id,
          },
        });

        if (createError) {
          errors.push({
            email: user.email,
            error: createError.message,
          });
        } else {
          results.push({
            email: user.email,
            id: authUser.user?.id,
          });
        }
      } catch (err) {
        errors.push({
          email: user.email,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    return new Response(
      JSON.stringify({
        message: 'User sync completed',
        synced: results.length,
        failed: errors.length,
        total: usersToSync.length,
        results,
        errors: errors.length > 0 ? errors : undefined,
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (error) {
    console.error('Error syncing users:', error);
    return new Response(
      JSON.stringify({
        error: 'Failed to sync users',
        message: error instanceof Error ? error.message : 'Unknown error',
      }),
      { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  }
});
