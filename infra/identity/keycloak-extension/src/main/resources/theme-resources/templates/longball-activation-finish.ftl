<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=true; section>
  <#if section == "header">Finish LongBall activation</#if>
  <#if section == "form">
    <p>Your credential and recovery codes were configured by this identity provider. Keep the recovery material safely. A team manager cannot retrieve your password.</p>
    <p>This is the fictional LongBall provider trial. Completing this flow does not approve household recovery authority or live onboarding.</p>
    <form id="longball-activation-finish" action="${url.loginAction}" method="post">
      <button type="submit" class="${properties.kcButtonClass!} ${properties.kcButtonPrimaryClass!}">Finish and return to LongBall</button>
    </form>
  </#if>
</@layout.registrationLayout>
