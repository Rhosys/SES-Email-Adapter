import { getQuickJS } from "quickjs-emscripten";
import jsonLogic from "json-logic-js";

export async function evalCondition(condition: string, ctx: object): Promise<boolean> {
  if (!condition.startsWith("js:")) {
    try {
      return Boolean(jsonLogic.apply(JSON.parse(condition) as object, ctx));
    } catch {
      return false;
    }
  }

  const qjs = await getQuickJS();
  const vm = qjs.newContext();
  try {
    vm.evalCode(`const ctx = ${JSON.stringify(ctx)};`);
    const result = vm.evalCode(`(function(ctx){ ${condition.slice(3)} })(ctx)`);
    if (result.error) {
      result.error.dispose();
      return false;
    }
    const val = vm.dump(result.value);
    result.value.dispose();
    return Boolean(val);
  } finally {
    vm.dispose();
  }
}
