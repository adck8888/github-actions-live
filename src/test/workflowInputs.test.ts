import * as assert from 'assert';
import { dispatchInputs } from '../workflowInputs';

describe('dispatchInputs', () => {
  it('reads inputs of every kind', () => {
    const inputs = dispatchInputs(`
on:
  push:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        default: staging
      dry_run:
        type: boolean
        default: true
      note:
        description: Why
        required: true
jobs: {}
`);
    assert.deepStrictEqual(
      inputs?.map((input) => [input.name, input.type, input.required]),
      [
        ['environment', 'choice', false],
        ['dry_run', 'boolean', false],
        ['note', 'string', true]
      ]
    );
    assert.deepStrictEqual(inputs?.[0].options, ['staging', 'production']);
  });

  it('accepts the short forms of the trigger', () => {
    assert.deepStrictEqual(dispatchInputs('on: workflow_dispatch\n'), []);
    assert.deepStrictEqual(dispatchInputs('on: [push, workflow_dispatch]\n'), []);
    assert.deepStrictEqual(dispatchInputs('on:\n  workflow_dispatch:\n'), []);
  });

  it('rejects workflows that cannot be run by hand', () => {
    assert.strictEqual(dispatchInputs('on: push\n'), undefined);
    assert.strictEqual(dispatchInputs('on:\n  schedule:\n    - cron: "0 0 * * *"\n'), undefined);
    assert.strictEqual(dispatchInputs(': : :'), undefined);
  });
});
