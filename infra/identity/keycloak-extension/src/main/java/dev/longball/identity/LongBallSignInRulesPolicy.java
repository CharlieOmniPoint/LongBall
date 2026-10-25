package dev.longball.identity;

import org.keycloak.Config;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.policy.PasswordPolicyProvider;
import org.keycloak.policy.PasswordPolicyProviderFactory;
import org.keycloak.policy.PolicyError;

/** Realm password policy: also invoked by ordinary password reset/admin credential flows. */
public final class LongBallSignInRulesPolicy implements PasswordPolicyProviderFactory {
  @Override public String getId() { return LongBallSignInRules.POLICY; }
  @Override public String getDisplayName() { return "LongBall application sign-in rules"; }
  @Override public String getConfigType() { return null; }
  @Override public String getDefaultConfigValue() { return null; }
  @Override public boolean isMultiplSupported() { return false; }
  @Override public void init(Config.Scope config) { }
  @Override public void postInit(KeycloakSessionFactory factory) { }
  @Override public void close() { }
  @Override public PasswordPolicyProvider create(KeycloakSession session) {
    return new PasswordPolicyProvider() {
      @Override public PolicyError validate(RealmModel realm, UserModel user, String password) {
        return check(realm, user.getUsername(), password);
      }
      @Override public PolicyError validate(String username, String password) {
        return check(session.getContext().getRealm(), username, password);
      }
      private PolicyError check(RealmModel realm, String username, String password) {
        try {
          String problem = LongBallSignInRules.read(realm).passwordProblem(username, password);
          return problem == null ? null : new PolicyError(problem);
        } catch (RuntimeException error) {
          return new PolicyError("LongBall sign-in rules are unavailable. Please try again later.");
        }
      }
      @Override public Object parseConfig(String value) { return Boolean.TRUE; }
      @Override public void close() { }
    };
  }
}
