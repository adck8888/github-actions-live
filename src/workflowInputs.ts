import { parse } from 'yaml';

export interface WorkflowInput {
  name: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  type?: string;
  options?: unknown[];
}

/** The `workflow_dispatch` inputs of a workflow file, or undefined when it cannot be run by hand. */
export function dispatchInputs(source: string): WorkflowInput[] | undefined {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object') {
    return undefined;
  }
  // YAML 1.1 readers turn a bare `on` into true; the yaml package keeps it as "on", but be safe.
  const on = (doc as Record<string, unknown>).on ?? (doc as Record<string, unknown>)['true'];
  if (on === 'workflow_dispatch') {
    return [];
  }
  if (Array.isArray(on)) {
    return on.includes('workflow_dispatch') ? [] : undefined;
  }
  if (!on || typeof on !== 'object' || !('workflow_dispatch' in on)) {
    return undefined;
  }
  const dispatch = (on as Record<string, unknown>).workflow_dispatch;
  const inputs = dispatch && typeof dispatch === 'object' ? (dispatch as Record<string, unknown>).inputs : undefined;
  if (!inputs || typeof inputs !== 'object') {
    return [];
  }
  return Object.entries(inputs as Record<string, Record<string, unknown> | null>).map(([name, spec]) => ({
    name,
    description: typeof spec?.description === 'string' ? spec.description : undefined,
    required: spec?.required === true,
    default: spec?.default,
    type: typeof spec?.type === 'string' ? spec.type : 'string',
    options: Array.isArray(spec?.options) ? spec.options : undefined
  }));
}
