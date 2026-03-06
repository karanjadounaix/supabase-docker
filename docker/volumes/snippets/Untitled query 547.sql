CREATE OR REPLACE FUNCTION public.add_user_to_organization(
    p_user_id uuid,
    p_organization_id uuid,
    p_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    UPDATE public.users
    SET organization_id = p_organization_id,
        role = p_role,
        updated_at = NOW()
    WHERE id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_invitation_accepted(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
    UPDATE public.invitations
    SET status = 'accepted',
        accepted_at = NOW(),
        updated_at = NOW()
    WHERE token = p_token
      AND status = 'pending';
END;
$$;
