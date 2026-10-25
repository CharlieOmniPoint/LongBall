package dev.longball.identity;

import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.keycloak.models.RealmModel;

/** Canonical, bounded rules shared by provisioning and every realm password change. */
final class LongBallSignInRules {
  static final String PREFIX = "longball.signInRules.";
  static final String POLICY = "longballSignInRules";
  // Match ECMAScript's whitespace set so the native/web rule and provider agree.
  private static final Pattern SYMBOL = Pattern.compile("[^A-Za-z0-9\\x{0009}-\\x{000D}\\x{0020}\\x{00A0}\\x{1680}\\x{2000}-\\x{200A}\\x{2028}\\x{2029}\\x{202F}\\x{205F}\\x{3000}\\x{FEFF}]");
  record Rules(int usernameMin, int usernameMax, boolean numbers, boolean separators,
      int passwordMin, boolean uppercase, boolean lowercase, boolean number,
      boolean symbol, boolean disallowUsername, boolean blockSimplePins) {
    boolean usernameAllowed(String username) {
      return username != null && username.length() >= usernameMin && username.length() <= usernameMax
        && username.matches("[A-Za-z0-9][A-Za-z0-9._-]*")
        && (numbers || !username.matches(".*[0-9].*"))
        && (separators || !username.matches(".*[._-].*"));
    }
    String passwordProblem(String username, String password) {
      if (password == null || password.length() < passwordMin || password.length() > 128)
        return "Use a password of " + passwordMin + "–128 characters.";
      if (uppercase && !password.matches("(?s).*[A-Z].*")) return "Include an uppercase letter.";
      if (lowercase && !password.matches("(?s).*[a-z].*")) return "Include a lowercase letter.";
      if (number && !password.matches("(?s).*[0-9].*")) return "Include a number.";
      if (symbol && !SYMBOL.matcher(password).find()) return "Include a symbol.";
      if (disallowUsername && username != null && !username.isBlank()
          && password.toLowerCase(Locale.ROOT).contains(username.trim().toLowerCase(Locale.ROOT)))
        return "Choose a password that does not contain your username.";
      return null;
    }
    void store(RealmModel realm) {
      realm.setAttribute(PREFIX + "usernameMin", Integer.toString(usernameMin));
      realm.setAttribute(PREFIX + "usernameMax", Integer.toString(usernameMax));
      realm.setAttribute(PREFIX + "numbers", Boolean.toString(numbers));
      realm.setAttribute(PREFIX + "separators", Boolean.toString(separators));
      realm.setAttribute(PREFIX + "passwordMin", Integer.toString(passwordMin));
      realm.setAttribute(PREFIX + "uppercase", Boolean.toString(uppercase));
      realm.setAttribute(PREFIX + "lowercase", Boolean.toString(lowercase));
      realm.setAttribute(PREFIX + "number", Boolean.toString(number));
      realm.setAttribute(PREFIX + "symbol", Boolean.toString(symbol));
      realm.setAttribute(PREFIX + "disallowUsername", Boolean.toString(disallowUsername));
      realm.setAttribute(PREFIX + "blockSimplePins", Boolean.toString(blockSimplePins));
    }
  }
  private LongBallSignInRules() { }
  static boolean acceptsRevision(long requested, Rules rules, String priorRevision, String fingerprint) {
    long prior = priorRevision == null ? -1 : Long.parseLong(priorRevision);
    return requested > prior || requested == prior && rules.toString().equals(fingerprint);
  }
  static Rules parse(Object value) {
    Map<?, ?> rules = object(value, Set.of("username", "password", "spectatorPin"));
    Map<?, ?> username = object(rules.get("username"), Set.of("minLength", "maxLength", "allowNumbers", "allowSeparators"));
    Map<?, ?> password = object(rules.get("password"), Set.of("minLength", "requireUppercase", "requireLowercase", "requireNumber", "requireSymbol", "disallowUsername"));
    Map<?, ?> pin = object(rules.get("spectatorPin"), Set.of("blockSimpleCodes"));
    int min = integer(username.get("minLength"), 3, 32);
    return new Rules(min, integer(username.get("maxLength"), Math.max(8, min), 40),
      bool(username.get("allowNumbers")), bool(username.get("allowSeparators")),
      integer(password.get("minLength"), 8, 64), bool(password.get("requireUppercase")),
      bool(password.get("requireLowercase")), bool(password.get("requireNumber")),
      bool(password.get("requireSymbol")), bool(password.get("disallowUsername")), bool(pin.get("blockSimpleCodes")));
  }
  static Rules read(RealmModel realm) {
    return new Rules(Integer.parseInt(realm.getAttribute(PREFIX + "usernameMin")),
      Integer.parseInt(realm.getAttribute(PREFIX + "usernameMax")), storedBool(realm, "numbers"), storedBool(realm, "separators"),
      Integer.parseInt(realm.getAttribute(PREFIX + "passwordMin")), storedBool(realm, "uppercase"), storedBool(realm, "lowercase"),
      storedBool(realm, "number"), storedBool(realm, "symbol"), storedBool(realm, "disallowUsername"), storedBool(realm, "blockSimplePins"));
  }
  static Rules defaults() { return new Rules(3, 40, true, true, 12, true, true, true, true, true, true); }
  private static boolean storedBool(RealmModel realm, String key) {
    String value = realm.getAttribute(PREFIX + key);
    if (!"true".equals(value) && !"false".equals(value)) throw new IllegalArgumentException("Missing sign-in rules.");
    return Boolean.parseBoolean(value);
  }
  private static Map<?, ?> object(Object value, Set<String> keys) {
    if (!(value instanceof Map<?, ?> map) || !map.keySet().equals(keys)) throw new IllegalArgumentException("Invalid sign-in rules.");
    return map;
  }
  private static int integer(Object value, int minimum, int maximum) {
    if (!(value instanceof Number number) || number.doubleValue() != number.intValue()
        || number.intValue() < minimum || number.intValue() > maximum) throw new IllegalArgumentException("Invalid sign-in rule length.");
    return number.intValue();
  }
  private static boolean bool(Object value) {
    if (!(value instanceof Boolean answer)) throw new IllegalArgumentException("Invalid sign-in rule flag.");
    return answer;
  }
}
