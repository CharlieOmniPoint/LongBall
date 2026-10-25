package dev.longball.identity;

import static org.junit.jupiter.api.Assertions.*;
import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.keycloak.models.RealmModel;
import org.keycloak.models.UserModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.PasswordPolicy;
import org.keycloak.policy.PasswordPolicyProvider;

final class LongBallSignInRulesTest {
  private Map<String, Object> rules() {
    return Map.of("username", Map.of("minLength", 3, "maxLength", 40, "allowNumbers", true, "allowSeparators", true),
      "password", Map.of("minLength", 12, "requireUppercase", true, "requireLowercase", true, "requireNumber", true,
        "requireSymbol", true, "disallowUsername", true), "spectatorPin", Map.of("blockSimpleCodes", true));
  }
  @Test void validatesNewNamedUsernamesAndRestrictions() {
    var parsed = LongBallSignInRules.parse(rules());
    assertTrue(parsed.usernameAllowed("Roma.SebL"));
    assertTrue(parsed.usernameAllowed("Roma.SebL2"));
    assertTrue(parsed.usernameAllowed("LBAAAAAAAAAAAA"));
    assertFalse(parsed.usernameAllowed("Roma SebL"));
    assertFalse(parsed.usernameAllowed("ab"));
    assertFalse(parsed.usernameAllowed("_Roma.SebL"));
    assertFalse(parsed.usernameAllowed("a".repeat(41)));
    var restricted = new HashMap<>(rules());
    restricted.put("username", Map.of("minLength", 3, "maxLength", 20, "allowNumbers", false, "allowSeparators", false));
    assertTrue(LongBallSignInRules.parse(restricted).usernameAllowed("RomaSebL"));
    assertFalse(LongBallSignInRules.parse(restricted).usernameAllowed("RomaSebL2"));
    assertFalse(LongBallSignInRules.parse(restricted).usernameAllowed("Roma.SebL"));
  }
  @Test void enforcesPasswordRulesIncludingSubstringAndWhitespace() {
    var parsed = LongBallSignInRules.parse(rules());
    assertNull(parsed.passwordProblem("Roma.SebL", "A-long-demo!47"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "short!7A"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "lowercase-only!7"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "UPPERCASE-ONLY!7"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "NoNumbers!!Here"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "Only Spaces 47"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "Only\u00a0Spaces\ufeff47"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "prefix-ROMA.SEBL-47!"));
    assertNotNull(parsed.passwordProblem("Roma.SebL", "A!47".repeat(33)));
  }
  @Test void rejectsMalformedOrUnboundedConfiguration() {
    assertThrows(IllegalArgumentException.class, () -> LongBallSignInRules.parse(Map.of()));
    var bad = new HashMap<>(rules());
    bad.put("username", Map.of("minLength", 3, "maxLength", 41, "allowNumbers", true, "allowSeparators", true));
    assertThrows(IllegalArgumentException.class, () -> LongBallSignInRules.parse(bad));
    bad.put("username", Map.of("minLength", 3.5, "maxLength", 40, "allowNumbers", true, "allowSeparators", true));
    assertThrows(IllegalArgumentException.class, () -> LongBallSignInRules.parse(bad));
  }
  @Test void onlyIdenticalRetriesCanReuseARevisionAndOlderUpdatesNeverReplaceNewerRules() {
    var parsed = LongBallSignInRules.parse(rules());
    assertTrue(LongBallSignInRules.acceptsRevision(0, parsed, null, null));
    assertTrue(LongBallSignInRules.acceptsRevision(3, parsed, "3", parsed.toString()));
    assertFalse(LongBallSignInRules.acceptsRevision(3, parsed, "3", "different-rules"));
    assertFalse(LongBallSignInRules.acceptsRevision(2, parsed, "3", parsed.toString()));
    assertTrue(LongBallSignInRules.acceptsRevision(4, parsed, "3", "different-rules"));
  }
  @Test void persistedRealmRulesApplyToAllCredentialValidationAndMissingRulesFailClosed() {
    var attributes = new HashMap<String, String>();
    var realm = (RealmModel) Proxy.newProxyInstance(RealmModel.class.getClassLoader(), new Class<?>[]{RealmModel.class},
      (proxy, method, args) -> switch (method.getName()) {
        case "getAttribute" -> attributes.get((String) args[0]);
        case "setAttribute" -> attributes.put((String) args[0], (String) args[1]);
        default -> throw new UnsupportedOperationException(method.getName());
      });
    var user = (UserModel) Proxy.newProxyInstance(UserModel.class.getClassLoader(), new Class<?>[]{UserModel.class},
      (proxy, method, args) -> {
        if (method.getName().equals("getUsername")) return "Roma.SebL";
        throw new UnsupportedOperationException(method.getName());
      });
    var provider = new LongBallSignInRulesPolicy().create(null);
    assertNotNull(provider.validate(realm, user, "A-long-demo!47"));
    LongBallSignInRules.parse(rules()).store(realm);
    assertEquals(LongBallSignInRules.parse(rules()), LongBallSignInRules.read(realm));
    assertNull(provider.validate(realm, user, "A-long-demo!47"));
    assertNotNull(provider.validate(realm, user, "NoNumbers!!Here"));
    attributes.remove(LongBallSignInRules.PREFIX + "uppercase");
    assertNotNull(provider.validate(realm, user, "A-long-demo!47"));
  }
  @Test void registersTheManagedPolicyAgainstThePinnedKeycloakModel() {
    assertTrue(PasswordPolicy.parse(null, null).getPolicies().isEmpty());
    var provider = new LongBallSignInRulesPolicy().create(null);
    var session = (KeycloakSession) Proxy.newProxyInstance(KeycloakSession.class.getClassLoader(), new Class<?>[]{KeycloakSession.class},
      (proxy, method, args) -> {
        if (method.getName().equals("getProvider") && args[0] == PasswordPolicyProvider.class
            && LongBallSignInRules.POLICY.equals(args[1])) return provider;
        throw new UnsupportedOperationException(method.getName());
      });
    var policy = PasswordPolicy.build().put(LongBallSignInRules.POLICY, null).build(session);
    assertTrue(policy.getPolicies().contains(LongBallSignInRules.POLICY));
    assertTrue(policy.toString().contains(LongBallSignInRules.POLICY));
  }
}
