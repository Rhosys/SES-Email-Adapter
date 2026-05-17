import * as acorn from "acorn";

export type AstValidationResult =
  | { valid: true }
  | { valid: false; error: string; location?: { line: number; column: number } };

const DISALLOWED_GLOBALS = new Set(["globalThis", "process", "Deno", "Bun"]);

/**
 * Validates user-submitted JavaScript code at API write time.
 *
 * The code must be a single ArrowFunctionExpression or FunctionExpression.
 * Disallowed constructs (eval, Function constructor, import, require,
 * global object access, unbounded loops) are rejected with an error message.
 */
export function validateCodeAst(code: string): AstValidationResult {
  // Try parsing as an expression first — this handles both arrow functions
  // and anonymous function expressions (which would be ambiguous as statements).
  let expr: acorn.Expression | undefined;
  try {
    expr = acorn.parseExpressionAt(code, 0, {
      ecmaVersion: "latest",
      sourceType: "script",
      locations: true,
    });
    // Ensure the expression consumes the entire input (no trailing code)
    if (expr.end !== code.length) {
      // There's trailing content — fall through to program parse for better error
      expr = undefined;
    }
  } catch {
    // Expression parse failed — try as a program for better error reporting
    expr = undefined;
  }

  if (!expr) {
    // Fall back to program-level parse for better error messages
    let program: acorn.Program;
    try {
      program = acorn.parse(code, {
        ecmaVersion: "latest",
        sourceType: "script",
        locations: true,
      });
    } catch (e: unknown) {
      if (e instanceof SyntaxError) {
        const loc = extractSyntaxErrorLocation(e);
        return { valid: false, error: e.message, location: loc };
      }
      return { valid: false, error: "Failed to parse code" };
    }

    // Structural requirement: must be a single ExpressionStatement
    if (program.body.length !== 1) {
      return { valid: false, error: "Code must be a single function expression" };
    }

    const stmt = program.body[0]!;
    if (stmt.type !== "ExpressionStatement") {
      return { valid: false, error: `Top-level ${stmt.type} is not allowed; code must be a function expression` };
    }

    expr = (stmt as acorn.ExpressionStatement).expression;
  }

  if (expr.type !== "ArrowFunctionExpression" && expr.type !== "FunctionExpression") {
    return { valid: false, error: `Top-level ${expr.type} is not allowed; code must be an arrow function or function expression` };
  }

  // Walk the AST and check for disallowed nodes
  return walkNode(expr);
}

function extractSyntaxErrorLocation(e: SyntaxError): { line: number; column: number } | undefined {
  // Acorn attaches loc to the error object
  const err = e as SyntaxError & { loc?: { line: number; column: number } };
  if (err.loc) {
    return { line: err.loc.line, column: err.loc.column };
  }
  return undefined;
}

function walkNode(node: acorn.Node): AstValidationResult {
  const loc = node.loc ? { line: node.loc.start.line, column: node.loc.start.column } : undefined;

  switch (node.type) {
    case "CallExpression": {
      const call = node as acorn.CallExpression;
      // Reject eval()
      if (call.callee.type === "Identifier" && (call.callee as acorn.Identifier).name === "eval") {
        return { valid: false, error: "eval() calls are not allowed", location: loc };
      }
      // Reject Function()
      if (call.callee.type === "Identifier" && (call.callee as acorn.Identifier).name === "Function") {
        return { valid: false, error: "Function constructor is not allowed", location: loc };
      }
      // Reject new Function() — handled via NewExpression but also catch Function() direct call
      // Reject require()
      if (call.callee.type === "Identifier" && (call.callee as acorn.Identifier).name === "require") {
        return { valid: false, error: "require() calls are not allowed", location: loc };
      }
      return walkChildren(node);
    }

    case "NewExpression": {
      const newExpr = node as acorn.NewExpression;
      if (newExpr.callee.type === "Identifier" && (newExpr.callee as acorn.Identifier).name === "Function") {
        return { valid: false, error: "Function constructor is not allowed", location: loc };
      }
      return walkChildren(node);
    }

    case "ImportExpression": {
      return { valid: false, error: "import() expressions are not allowed", location: loc };
    }

    case "MemberExpression": {
      const member = node as acorn.MemberExpression;
      // Reject access on globalThis, process, Deno, Bun
      if (member.object.type === "Identifier") {
        const name = (member.object as acorn.Identifier).name;
        if (DISALLOWED_GLOBALS.has(name)) {
          return { valid: false, error: `Access on '${name}' is not allowed`, location: loc };
        }
      }
      return walkChildren(node);
    }

    case "WhileStatement":
    case "DoWhileStatement": {
      if (!hasBoundedGuard(node)) {
        return { valid: false, error: `Unbounded ${node.type} is not allowed; add a numeric limit or break`, location: loc };
      }
      return walkChildren(node);
    }

    case "ForStatement": {
      if (!hasBoundedGuard(node)) {
        return { valid: false, error: "Unbounded ForStatement is not allowed; add a numeric limit in the condition", location: loc };
      }
      return walkChildren(node);
    }

    case "ForInStatement":
    case "ForOfStatement": {
      // for-in and for-of iterate over finite collections — allow them
      return walkChildren(node);
    }

    case "VariableDeclaration": {
      const decl = node as acorn.VariableDeclaration;
      if (decl.kind === "var") {
        return { valid: false, error: "'var' declarations are not allowed; use 'const' or 'let'", location: loc };
      }
      return walkChildren(node);
    }

    // All other node types — walk children
    default:
      return walkChildren(node);
  }
}

/**
 * Checks whether a loop has a bounded iteration guard:
 * - A numeric literal in the test condition (e.g. `i < 100`)
 * - A break statement in the body
 */
function hasBoundedGuard(node: acorn.Node): boolean {
  switch (node.type) {
    case "WhileStatement": {
      const whileNode = node as acorn.WhileStatement;
      return hasNumericBound(whileNode.test) || hasBreakStatement(whileNode.body);
    }
    case "DoWhileStatement": {
      const doNode = node as acorn.DoWhileStatement;
      return hasNumericBound(doNode.test) || hasBreakStatement(doNode.body);
    }
    case "ForStatement": {
      const forNode = node as acorn.ForStatement;
      if (forNode.test && hasNumericBound(forNode.test)) return true;
      return hasBreakStatement(forNode.body);
    }
    default:
      return false;
  }
}

/** Checks if an expression contains a numeric literal (indicating a bound). */
function hasNumericBound(node: acorn.Node): boolean {
  if (node.type === "Literal") {
    const lit = node as acorn.Literal;
    return typeof lit.value === "number";
  }
  if (node.type === "BinaryExpression") {
    const bin = node as acorn.BinaryExpression;
    return hasNumericBound(bin.left as acorn.Node) || hasNumericBound(bin.right);
  }
  if (node.type === "LogicalExpression") {
    const log = node as acorn.LogicalExpression;
    return hasNumericBound(log.left) || hasNumericBound(log.right);
  }
  return false;
}

/** Checks if a statement (or block) contains a BreakStatement. */
function hasBreakStatement(node: acorn.Node): boolean {
  if (node.type === "BreakStatement") return true;
  if (node.type === "BlockStatement") {
    const block = node as acorn.BlockStatement;
    return block.body.some(s => hasBreakStatement(s));
  }
  if (node.type === "IfStatement") {
    const ifStmt = node as acorn.IfStatement;
    if (hasBreakStatement(ifStmt.consequent)) return true;
    if (ifStmt.alternate && hasBreakStatement(ifStmt.alternate)) return true;
  }
  return false;
}

/** Recursively walk all child nodes of a given AST node. */
function walkChildren(node: acorn.Node): AstValidationResult {
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end" || key === "loc" || key === "range") continue;

    const value = (node as unknown as Record<string, unknown>)[key];
    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        for (const item of value) {
          if (item && typeof item === "object" && "type" in item) {
            const result = walkNode(item as acorn.Node);
            if (!result.valid) return result;
          }
        }
      } else if ("type" in value) {
        const result = walkNode(value as acorn.Node);
        if (!result.valid) return result;
      }
    }
  }
  return { valid: true };
}
