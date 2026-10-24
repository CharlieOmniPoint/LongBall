-- Even a scoped staff writer cannot alter an inherited Manager membership as
-- an appointed-coach row. Grant changes reconcile inherited rows separately.
CREATE POLICY appointed_manager_updates ON longball.memberships AS RESTRICTIVE FOR UPDATE
 USING(role<>'manager' OR NOT EXISTS(SELECT 1 FROM longball.administrative_memberships a WHERE a.account_id=memberships.account_id AND a.team_id=memberships.team_id AND a.season_id=memberships.season_id AND a.role=memberships.role))
 WITH CHECK(role<>'manager' OR NOT EXISTS(SELECT 1 FROM longball.administrative_memberships a WHERE a.account_id=memberships.account_id AND a.team_id=memberships.team_id AND a.season_id=memberships.season_id AND a.role=memberships.role));
