package dev.longball.identity;

import com.fasterxml.jackson.annotation.JsonProperty;
import jakarta.persistence.LockModeType;
import jakarta.ws.rs.Consumes;
import jakarta.ws.rs.POST;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.WebApplicationException;
import jakarta.ws.rs.core.MediaType;
import jakarta.ws.rs.core.Response;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.keycloak.Config;
import org.keycloak.TokenVerifier;
import org.keycloak.authentication.RequiredActionContext;
import org.keycloak.authentication.RequiredActionFactory;
import org.keycloak.authentication.RequiredActionProvider;
import org.keycloak.authentication.InitiatedActionSupport;
import org.keycloak.authentication.actiontoken.AbstractActionTokenHandler;
import org.keycloak.authentication.actiontoken.ActionTokenContext;
import org.keycloak.authentication.actiontoken.DefaultActionToken;
import org.keycloak.authentication.actiontoken.TokenUtils;
import org.keycloak.authentication.requiredactions.UpdatePassword;
import org.keycloak.authentication.requiredactions.RecoveryAuthnCodesAction;
import org.keycloak.common.util.Time;
import org.keycloak.connections.jpa.JpaConnectionProvider;
import org.keycloak.events.Errors;
import org.keycloak.events.EventType;
import org.keycloak.models.ClientModel;
import org.keycloak.models.KeycloakSession;
import org.keycloak.models.KeycloakSessionFactory;
import org.keycloak.models.RealmModel;
import org.keycloak.models.PasswordPolicy;
import org.keycloak.models.UserModel;
import org.keycloak.models.credential.PasswordCredentialModel;
import org.keycloak.models.credential.RecoveryAuthnCodesCredentialModel;
import org.keycloak.models.jpa.entities.UserEntity;
import org.keycloak.models.jpa.entities.RealmEntity;
import org.keycloak.protocol.oidc.OIDCLoginProtocol;
import org.keycloak.protocol.oidc.utils.RedirectUtils;
import org.keycloak.services.Urls;
import org.keycloak.services.managers.AppAuthManager;
import org.keycloak.services.managers.AuthenticationManager;
import org.keycloak.services.messages.Messages;
import org.keycloak.services.resource.RealmResourceProvider;
import org.keycloak.services.resource.RealmResourceProviderFactory;
import org.keycloak.sessions.AuthenticationSessionCompoundId;
import org.keycloak.sessions.AuthenticationSessionModel;

/** Pinned fictional trial of Keycloak's documented internal extension SPIs, not live-onboarding approval. */
public final class LongBallActivation implements RealmResourceProviderFactory {
  public static final String ID = "longball-activation";
  private static final String TYPE = "longball-activate";
  private static final String PREFIX = "longball.activation.";
  private static final String ACCOUNT = PREFIX + "account";
  private static final String OPERATION = PREFIX + "operation";
  private static final String FLOW = PREFIX + "flow";
  private static final String EXPIRES = PREFIX + "expires";
  private static final String STATUS = PREFIX + "status";
  private static final String SESSION = PREFIX + "session";
  private static final String CANCELLED = PREFIX + "cancelled";
  private static final String REDIRECT = PREFIX + "redirect";
  private static final String PROOF = PREFIX + "proofHash";
  private static final String COMPLETED = PREFIX + "completedAt";
  private static final String PASSWORD = "longball-update-password";
  private static final String RECOVERY = "longball-recovery-codes";
  private static final String FINISH = "longball-finish-activation";
  private static final List<String> ACTIONS = List.of(PASSWORD, RECOVERY, FINISH);

  @Override public String getId() { return ID; }
  @Override public void init(Config.Scope config) { }
  @Override public void postInit(KeycloakSessionFactory factory) { }
  @Override public void close() { }
  @Override public RealmResourceProvider create(KeycloakSession session) {
    return new RealmResourceProvider() {
      @Override public Object getResource() { return new Resource(session); }
      @Override public void close() { }
    };
  }

  static WebApplicationException denied(int status) {
    return new WebApplicationException(Response.status(status).type(MediaType.APPLICATION_JSON_TYPE)
      .header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer")
      .entity(Map.of("code", "ACTIVATION_FLOW_UNAVAILABLE", "message", "The activation flow is unavailable.")).build());
  }
  static void trial(KeycloakSession session) {
    if (!"enabled".equals(session.getContext().getRealm().getAttribute("longball.fictionalActivationTrial"))
        || !"https".equals(session.getContext().getUri().getBaseUri().getScheme())) throw denied(503);
  }
  static String value(Map<String, Object> input, String key) {
    Object value = input.get(key);
    if (!(value instanceof String text) || text.isEmpty() || text.length() > 2048) throw denied(400);
    return text;
  }
  static void fields(Map<String, Object> input, String... keys) {
    if (input == null || !input.keySet().equals(Set.of(keys))) throw denied(400);
  }
  static String hash(String value) {
    try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
    catch (Exception error) { throw denied(503); }
  }
  static String issuer(KeycloakSession session) {
    return Urls.realmIssuer(session.getContext().getUri().getBaseUri(), session.getContext().getRealm().getName());
  }
  static UserModel lock(KeycloakSession session, String subject) {
    var realm = session.getContext().getRealm();
    var entity = session.getProvider(JpaConnectionProvider.class).getEntityManager()
      .find(UserEntity.class, subject, LockModeType.PESSIMISTIC_WRITE);
    if (entity == null || !realm.getId().equals(entity.getRealmId())) throw denied(410);
    UserModel user = session.users().getUserById(realm, subject);
    if (user == null || user.getFirstAttribute(ACCOUNT) == null
        || !Set.of("child_shared", "unclassified").contains(String.valueOf(user.getFirstAttribute("longball.classification")))) throw denied(410);
    return user;
  }
  static String flow(String operation) {
    if (!operation.startsWith("activation:")) throw denied(400);
    try { return UUID.fromString(operation.substring("activation:".length())).toString(); }
    catch (IllegalArgumentException error) { throw denied(400); }
  }
  static long expiry(UserModel user) {
    try { return Long.parseLong(user.getFirstAttribute(EXPIRES)); }
    catch (Exception error) { throw denied(410); }
  }
  static void active(KeycloakSession session, AuthenticationSessionModel authSession) {
    trial(session);
    UserModel user = lock(session, authSession.getAuthenticatedUser().getId());
    String operation = authSession.getAuthNote(OPERATION);
    String compound = AuthenticationSessionCompoundId.fromAuthSession(authSession).getEncodedId();
    if (!user.isEnabled() || !"setup".equals(user.getFirstAttribute(STATUS))
        || operation == null || !operation.equals(user.getFirstAttribute(OPERATION))
        || user.getAttributeStream(CANCELLED).anyMatch(operation::equals)
        || !compound.equals(user.getFirstAttribute(SESSION)) || expiry(user) <= System.currentTimeMillis()) throw denied(410);
  }

  @Consumes(MediaType.APPLICATION_JSON) @Produces(MediaType.APPLICATION_JSON)
  public static final class Resource {
    private final KeycloakSession session;
    Resource(KeycloakSession session) { this.session = session; }
    private void service() {
      trial(session);
      var realm = session.getContext().getRealm();
      var auth = new AppAuthManager.BearerTokenAuthenticator(session).setRealm(realm)
        .setConnection(session.getContext().getConnection()).setHeaders(session.getContext().getRequestHeaders()).authenticate();
      var role = realm.getRole("longball-activation-provisioner");
      if (auth == null || auth.user().getServiceAccountClientLink() == null || role == null
          || !auth.user().hasRole(role) || !"longball-activation-service".equals(auth.token().getIssuedFor())) throw denied(403);
    }
    @POST @Path("sign-in-rules")
    public Map<String, Object> signInRules(Map<String, Object> input) {
      service(); fields(input, "revision", "rules");
      Object revisionValue = input.get("revision");
      if (!(revisionValue instanceof Number number) || number.doubleValue() != number.longValue()
          || number.longValue() < 0 || number.longValue() > 9007199254740991L) throw denied(400);
      long revision = number.longValue();
      LongBallSignInRules.Rules rules;
      try { rules = LongBallSignInRules.parse(input.get("rules")); }
      catch (IllegalArgumentException error) { throw denied(400); }
      RealmModel realm = session.getContext().getRealm();
      // Serialise realm policy writes even when the provider runs on multiple nodes.
      var entities = session.getProvider(JpaConnectionProvider.class).getEntityManager();
      RealmEntity entity = entities.find(RealmEntity.class, realm.getId(), LockModeType.PESSIMISTIC_WRITE);
      if (entity == null) throw denied(503);
      // The request's RealmModel may have come from the distributed cache before
      // the lock. Read revision and source policy from the refreshed locked row.
      entities.refresh(entity, LockModeType.PESSIMISTIC_WRITE);
      List<Object[]> stored = entities.createQuery(
          "SELECT a.name,a.value FROM RealmAttributeEntity a WHERE a.realm.id=:id AND a.name IN :names", Object[].class)
        .setParameter("id", realm.getId())
        .setParameter("names", Set.of(LongBallSignInRules.PREFIX + "revision", LongBallSignInRules.PREFIX + "fingerprint"))
        .setHint("jakarta.persistence.cache.retrieveMode", jakarta.persistence.CacheRetrieveMode.BYPASS)
        .getResultList();
      String revisionText = stored.stream().filter(attribute -> (LongBallSignInRules.PREFIX + "revision").equals(attribute[0]))
        .map(attribute -> (String) attribute[1]).findFirst().orElse(null);
      String fingerprint = stored.stream().filter(attribute -> (LongBallSignInRules.PREFIX + "fingerprint").equals(attribute[0]))
        .map(attribute -> (String) attribute[1]).findFirst().orElse(null);
      if (!LongBallSignInRules.acceptsRevision(revision, rules, revisionText, fingerprint)) throw denied(409);
      rules.store(realm);
      // Keep independently configured hashing/history/breach rules. These managed clauses
      // are replaced by the exact LongBall policy so Super Admin's settings are effective.
      String sourcePolicy = entity.getPasswordPolicy();
      PasswordPolicy.Builder policy = sourcePolicy == null || sourcePolicy.isBlank()
        ? PasswordPolicy.build() : PasswordPolicy.parse(session, sourcePolicy).toBuilder();
      for (String managed : List.of("length", "maxLength", "upperCase", "lowerCase", "digits", "specialChars", "notUsername", "notContainsUsername")) policy.remove(managed);
      policy.put(LongBallSignInRules.POLICY, null);
      realm.setPasswordPolicy(policy.build(session));
      realm.setAttribute(LongBallSignInRules.PREFIX + "revision", Long.toString(revision));
      realm.setAttribute(LongBallSignInRules.PREFIX + "fingerprint", rules.toString());
      if (!realm.getPasswordPolicy().getPolicies().contains(LongBallSignInRules.POLICY)) throw denied(503);
      return Map.of("revision", revision, "enforced", true);
    }
    @POST @Path("pending")
    public Map<String, Object> pending(Map<String, Object> input) {
      service(); fields(input, "operationId", "accountId", "username", "classification", "emailRequired");
      String accountId = value(input, "accountId"), username = value(input, "username"), classification = value(input, "classification");
      try { UUID.fromString(accountId); } catch (IllegalArgumentException error) { throw denied(400); }
      if (!value(input, "operationId").equals("pending:" + accountId) || !Set.of("child_shared", "unclassified").contains(classification)
          || !Boolean.FALSE.equals(input.get("emailRequired"))) throw denied(400);
      RealmModel realm = session.getContext().getRealm();
      UserModel user = session.users().getUserByUsername(realm, username);
      if (user == null) {
        LongBallSignInRules.Rules rules = realm.getAttribute(LongBallSignInRules.PREFIX + "revision") == null
          ? LongBallSignInRules.defaults() : LongBallSignInRules.read(realm);
        if (!rules.usernameAllowed(username)) throw denied(400);
        if (session.users().getUserById(realm, accountId) != null) throw denied(409);
        user = session.users().addUser(realm, accountId, username, false, false);
        user.setEnabled(false); user.setSingleAttribute(ACCOUNT, accountId);
        user.setSingleAttribute("longball.classification", classification);
        user.setSingleAttribute(STATUS, "pending");
      }
      if (!accountId.equals(user.getId()) || !accountId.equals(user.getFirstAttribute(ACCOUNT))
          || !classification.equals(user.getFirstAttribute("longball.classification"))
          || user.isEnabled() || user.credentialManager().isConfiguredFor(PasswordCredentialModel.TYPE)) throw denied(409);
      return Map.of("issuer", issuer(session), "subject", user.getId(), "username", user.getUsername(), "pending", true, "credentialConfigured", false);
    }
    @POST @Path("begin")
    public Map<String, Object> begin(Map<String, Object> input) {
      service(); fields(input, "operationId", "accountId", "issuer", "subject", "username", "expiresAt", "redirectUri", "clientId");
      String operation = value(input, "operationId"), flow = flow(operation);
      UserModel user = lock(session, value(input, "subject"));
      if (!issuer(session).equals(input.get("issuer")) || !user.getId().equals(input.get("accountId"))
          || !user.getUsername().equalsIgnoreCase(value(input, "username")) || "complete".equals(user.getFirstAttribute(STATUS))
          || user.getAttributeStream(CANCELLED).anyMatch(operation::equals)) throw denied(409);
      Object requestedExpiry = input.get("expiresAt");
      if (!(requestedExpiry instanceof Number number)) throw denied(400);
      long expiresAt = number.longValue() / 1000 * 1000;
      if (expiresAt <= System.currentTimeMillis() || expiresAt / 1000 > Integer.MAX_VALUE) throw denied(410);
      String existing = user.getFirstAttribute(OPERATION);
      if (existing != null && !existing.equals(operation) && !"cancelled".equals(user.getFirstAttribute(STATUS))) throw denied(409);
      if (operation.equals(existing) && expiry(user) != expiresAt) throw denied(409);
      ClientModel client = session.clients().getClientByClientId(session.getContext().getRealm(), value(input, "clientId"));
      String redirect = value(input, "redirectUri");
      if (client == null || !client.isPublicClient() || !client.isEnabled() || URI.create(redirect).getFragment() != null
          || RedirectUtils.verifyRedirectUri(session, redirect, client) == null) throw denied(400);
      user.setEnabled(true); user.setSingleAttribute(OPERATION, operation); user.setSingleAttribute(FLOW, flow);
      user.setSingleAttribute(EXPIRES, Long.toString(expiresAt)); user.setSingleAttribute(REDIRECT, redirect);
      user.setSingleAttribute(STATUS, "setup"); ACTIONS.forEach(user::addRequiredAction);
      ActivationToken token = new ActivationToken(user.getId(), (int) (expiresAt / 1000), UUID.fromString(flow), flow);
      token.issuedFor(client.getClientId());
      String setup = Urls.loginActionsBase(session.getContext().getUri().getBaseUri()).path("action-token")
        .queryParam("key", token.serialize(session, session.getContext().getRealm(), session.getContext().getUri())).queryParam("client_id", client.getClientId())
        .build(session.getContext().getRealm().getName()).toString();
      return Map.of("flowId", flow, "setupUrl", setup, "expiresAt", expiresAt);
    }
    @POST @Path("cancel")
    public Map<String, Object> cancel(Map<String, Object> input) {
      service(); fields(input, "operationId", "issuer", "subject");
      String operation = value(input, "operationId"); flow(operation);
      if (!issuer(session).equals(input.get("issuer"))) throw denied(400);
      UserModel user = lock(session, value(input, "subject"));
      if ("complete".equals(user.getFirstAttribute(STATUS))) throw denied(409);
      Set<String> cancelled = new HashSet<>(user.getAttributeStream(CANCELLED).toList());
      cancelled.add(operation); user.setAttribute(CANCELLED, new ArrayList<>(cancelled));
      if (operation.equals(user.getFirstAttribute(OPERATION))) {
        user.setSingleAttribute(STATUS, "cancelled"); user.setEnabled(false); user.removeAttribute(SESSION);
      }
      return Map.of("cancelled", true);
    }
    @POST @Path("verify")
    public Map<String, Object> verify(Map<String, Object> input) {
      service(); fields(input, "operationId", "flowId", "issuer", "subject", "completionProof");
      UserModel user = lock(session, value(input, "subject"));
      String operation = value(input, "operationId");
      String supplied = hash(value(input, "completionProof")), expected = user.getFirstAttribute(PROOF);
      if (!issuer(session).equals(input.get("issuer")) || !flow(operation).equals(input.get("flowId"))
          || !operation.equals(user.getFirstAttribute(OPERATION)) || !"complete".equals(user.getFirstAttribute(STATUS))
          || expected == null || !MessageDigest.isEqual(supplied.getBytes(StandardCharsets.UTF_8), expected.getBytes(StandardCharsets.UTF_8))
          || expiry(user) <= System.currentTimeMillis() || !user.credentialManager().isConfiguredFor(PasswordCredentialModel.TYPE)
          || !user.credentialManager().isConfiguredFor(RecoveryAuthnCodesCredentialModel.TYPE)) throw denied(410);
      return Map.of("issuer", issuer(session), "subject", user.getId(), "flowId", input.get("flowId"),
        "completedAt", Long.parseLong(user.getFirstAttribute(COMPLETED)), "credentialConfigured", true, "recoveryMaterialIssued", true);
    }
  }

  public static final class ActivationToken extends DefaultActionToken {
    @JsonProperty("longball-flow") private String flowId;
    public ActivationToken() { super(); }
    ActivationToken(String userId, int expiry, UUID nonce, String flowId) { super(userId, TYPE, expiry, nonce); this.flowId = flowId; }
    public String flowId() { return flowId; }
  }
  public static final class TokenHandler extends AbstractActionTokenHandler<ActivationToken> {
    public TokenHandler() { super(TYPE, ActivationToken.class, Messages.INVALID_CODE, EventType.EXECUTE_ACTIONS, Errors.NOT_ALLOWED); }
    @Override public boolean canUseTokenRepeatedly(ActivationToken token, ActionTokenContext<ActivationToken> context) { return false; }
    @Override public TokenVerifier.Predicate<? super ActivationToken>[] getVerifiers(ActionTokenContext<ActivationToken> context) {
      return TokenUtils.predicates(TokenUtils.checkThat(token -> token.flowId() != null && token.flowId().equals(context.getAuthenticationSession().getAuthenticatedUser().getFirstAttribute(FLOW)), Errors.INVALID_TOKEN, Messages.INVALID_CODE));
    }
    @Override public Response handleToken(ActivationToken token, ActionTokenContext<ActivationToken> context) {
      trial(context.getSession());
      AuthenticationSessionModel auth = context.getAuthenticationSession();
      UserModel user = lock(context.getSession(), auth.getAuthenticatedUser().getId());
      String compound = AuthenticationSessionCompoundId.fromAuthSession(auth).getEncodedId();
      String prior = user.getFirstAttribute(SESSION);
      if (!"setup".equals(user.getFirstAttribute(STATUS)) || expiry(user) <= System.currentTimeMillis()
          || prior != null && !prior.equals(compound)) throw denied(410);
      user.setSingleAttribute(SESSION, compound); auth.setAuthNote(OPERATION, user.getFirstAttribute(OPERATION));
      ACTIONS.forEach(auth::addRequiredAction);
      String action = AuthenticationManager.nextRequiredAction(context.getSession(), auth, context.getRequest(), context.getEvent());
      return AuthenticationManager.redirectToRequiredActions(context.getSession(), context.getRealm(), auth, context.getUriInfo(), action);
    }
  }
  public static final class PasswordAction extends UpdatePassword {
    @Override public String getId() { return PASSWORD; }
    @Override public String getDisplayText() { return "LongBall account password"; }
    @Override public RequiredActionProvider create(KeycloakSession session) { return this; }
    @Override public void evaluateTriggers(RequiredActionContext context) { }
    @Override public void requiredActionChallenge(RequiredActionContext context) { active(context.getSession(), context.getAuthenticationSession()); super.requiredActionChallenge(context); }
    @Override public void processAction(RequiredActionContext context) { active(context.getSession(), context.getAuthenticationSession()); super.processAction(context); }
  }
  public static final class RecoveryAction extends RecoveryAuthnCodesAction {
    @Override public String getId() { return RECOVERY; }
    @Override public String getDisplayText() { return "LongBall recovery codes"; }
    @Override public RequiredActionProvider create(KeycloakSession session) { return this; }
    @Override public void requiredActionChallenge(RequiredActionContext context) { active(context.getSession(), context.getAuthenticationSession()); super.requiredActionChallenge(context); }
    @Override public void processAction(RequiredActionContext context) { active(context.getSession(), context.getAuthenticationSession()); super.processAction(context); }
  }
  public static final class FinishAction implements RequiredActionProvider, RequiredActionFactory {
    @Override public String getId() { return FINISH; }
    @Override public String getDisplayText() { return "Finish LongBall activation"; }
    @Override public RequiredActionProvider create(KeycloakSession session) { return this; }
    @Override public void init(Config.Scope config) { }
    @Override public void postInit(KeycloakSessionFactory factory) { }
    @Override public void close() { }
    @Override public void evaluateTriggers(RequiredActionContext context) { }
    @Override public InitiatedActionSupport initiatedActionSupport() { return InitiatedActionSupport.NOT_SUPPORTED; }
    @Override public void requiredActionChallenge(RequiredActionContext context) {
      active(context.getSession(), context.getAuthenticationSession());
      context.challenge(context.form().createForm("longball-activation-finish.ftl"));
    }
    @Override public void processAction(RequiredActionContext context) {
      active(context.getSession(), context.getAuthenticationSession());
      UserModel user = context.getUser();
      if (!user.credentialManager().isConfiguredFor(PasswordCredentialModel.TYPE)
          || !user.credentialManager().isConfiguredFor(RecoveryAuthnCodesCredentialModel.TYPE)) throw denied(410);
      byte[] bytes = new byte[32]; new SecureRandom().nextBytes(bytes);
      String proof = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
      user.setSingleAttribute(PROOF, hash(proof)); user.setSingleAttribute(COMPLETED, Long.toString(System.currentTimeMillis()));
      user.setSingleAttribute(STATUS, "complete");
      AuthenticationSessionModel auth = context.getAuthenticationSession();
      String redirect = user.getFirstAttribute(REDIRECT) + "#longballActivation=" + user.getFirstAttribute(FLOW) + "&completionProof=" + proof;
      auth.setRedirectUri(redirect); auth.setClientNote(OIDCLoginProtocol.REDIRECT_URI_PARAM, redirect);
      auth.setAuthNote(AuthenticationManager.SET_REDIRECT_URI_AFTER_REQUIRED_ACTIONS, "true");
      auth.setAuthNote(AuthenticationManager.END_AFTER_REQUIRED_ACTIONS, "true");
      context.success();
    }
  }
}
