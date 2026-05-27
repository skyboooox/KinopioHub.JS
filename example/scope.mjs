import { uniqueName, usingDemoHub } from "./_shared.mjs";

await usingDemoHub(async (hub) => {
  const scopeName = uniqueName("scope").replaceAll(".", "_");

  const scope = hub.getScope(scopeName);
  const viaMethod = scope.getVariable("status");
  const viaDynamicAccess = hub[scopeName].status;

  console.log("method subject:", viaMethod.subject);
  console.log("dynamic subject:", viaDynamicAccess.subject);

  await viaMethod.pub({ source: "getVariable", at: Date.now() });
  await viaDynamicAccess.pub({ source: "dynamic-access", at: Date.now() });

  console.log("latest local value:", viaDynamicAccess.value);
});
