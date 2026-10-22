import * as vscode from 'vscode';

/**
 * Pro licences are sold through Lemon Squeezy, which issues a licence key per
 * order and switches it off when a subscription ends. The key is checked with
 * Lemon Squeezy's public licence API; no secret lives in the extension.
 */
export const PRO = {
  /** Lemon Squeezy store the licence must belong to. */
  storeId: 471716,
  /** Products that unlock Pro; one product carries both the monthly and the lifetime variant. */
  productIds: [1390632] as number[],
  /** The product's checkout, where the buyer picks Monthly or Lifetime. */
  monthlyUrl: 'https://briproof.lemonsqueezy.com/checkout/buy/42858d40-be39-45dd-8aaa-725fb0694223',
  lifetimeUrl: 'https://briproof.lemonsqueezy.com/checkout/buy/42858d40-be39-45dd-8aaa-725fb0694223',
  monthlyPrice: '$4/month',
  lifetimePrice: '$39 once',
  trialDays: 7
};

const PRO_FEATURES =
  'Pro puts the errors of a failed run in the Problems panel on the lines they point to, even after you edited the files; notifies you, through the system when VS Code is in the background, when CI finishes or a deployment waits for you; shows what changed since a workflow was last green, with a diff of the two logs; and finds flaky runs and steps that fail most or got slower.';

const API = 'https://api.lemonsqueezy.com/v1/licenses';
const SECRET_KEY = 'actionsLive.licenseKey';
const STATE_KEY = 'actionsLive.license';
const TRIAL_KEY = 'actionsLive.trialStartedAt';
/** Revalidate in the background this often. */
const REVALIDATE_MS = 3 * 24 * 3600 * 1000;
/** Keep Pro working offline this long after the last successful check. */
const GRACE_MS = 14 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

interface StoredLicense {
  instanceId: string;
  /** Lemon Squeezy's key status: active, inactive, expired, disabled. */
  status: string;
  plan?: string;
  validatedAt: number;
}

interface LicenseResponse {
  activated?: boolean;
  valid?: boolean;
  deactivated?: boolean;
  error?: string | null;
  license_key?: { status?: string };
  instance?: { id?: string } | null;
  meta?: { store_id?: number; product_id?: number; product_name?: string; variant_name?: string };
}

/** Holds the licence and trial state and tells the rest of the extension when Pro turns on or off. */
export class License implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<boolean>();
  readonly onDidChange = this.changed.event;
  private trialTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.scheduleTrialEnd();
  }

  dispose(): void {
    clearTimeout(this.trialTimer);
    this.changed.dispose();
  }

  private get stored(): StoredLicense | undefined {
    return this.context.globalState.get<StoredLicense>(STATE_KEY);
  }

  get isLicensed(): boolean {
    const stored = this.stored;
    return Boolean(stored && stored.status === 'active' && Date.now() - stored.validatedAt < GRACE_MS);
  }

  get isPro(): boolean {
    return this.isLicensed || this.trialDaysLeft > 0;
  }

  get plan(): string | undefined {
    return this.isLicensed ? this.stored?.plan : this.trialDaysLeft > 0 ? 'trial' : undefined;
  }

  get trialStarted(): boolean {
    return this.context.globalState.get<number>(TRIAL_KEY) !== undefined;
  }

  /** Whole days of the trial left, rounded up; 0 when it has not started or is over. */
  get trialDaysLeft(): number {
    const started = this.context.globalState.get<number>(TRIAL_KEY);
    if (started === undefined) {
      return 0;
    }
    return Math.max(0, Math.ceil((started + PRO.trialDays * DAY_MS - Date.now()) / DAY_MS));
  }

  async startTrial(): Promise<boolean> {
    if (this.trialStarted) {
      return this.isPro;
    }
    await this.context.globalState.update(TRIAL_KEY, Date.now());
    this.scheduleTrialEnd();
    this.changed.fire(true);
    void vscode.window.showInformationMessage(`Pro is on for ${PRO.trialDays} days. ${PRO_FEATURES}`);
    return true;
  }

  private scheduleTrialEnd(): void {
    clearTimeout(this.trialTimer);
    const started = this.context.globalState.get<number>(TRIAL_KEY);
    const left = started === undefined ? 0 : started + PRO.trialDays * DAY_MS - Date.now();
    // setTimeout cannot wait longer than about 24 days; the trial is shorter.
    if (left > 0 && left < 2 ** 31 - 1) {
      this.trialTimer = setTimeout(() => {
        if (!this.isLicensed) {
          this.changed.fire(false);
          void vscode.window
            .showInformationMessage('The Actions Live Pro trial has ended. Live runs, logs and the status bar stay free.', 'Get Pro')
            .then((choice) => choice && offerPro(this, 'Pro'));
        }
      }, left + 1000);
    }
  }

  /** Called on activation: rechecks a licence that has not been checked for a few days. */
  async refresh(): Promise<void> {
    const stored = this.stored;
    if (!stored || Date.now() - stored.validatedAt < REVALIDATE_MS) {
      return;
    }
    const key = await this.context.secrets.get(SECRET_KEY);
    if (!key) {
      return;
    }
    let response: LicenseResponse;
    try {
      response = await call('validate', { license_key: key, instance_id: stored.instanceId });
    } catch {
      // Offline: the grace period covers it.
      return;
    }
    const wasPro = this.isPro;
    const status = response.valid && this.belongsToUs(response) ? response.license_key?.status ?? 'active' : response.license_key?.status ?? 'invalid';
    await this.context.globalState.update(STATE_KEY, { ...stored, status, validatedAt: Date.now() });
    if (wasPro !== this.isPro) {
      this.changed.fire(this.isPro);
      if (!this.isPro) {
        void vscode.window
          .showWarningMessage(`GitHub Actions Live Pro is no longer active (licence ${status}).`, 'Renew')
          .then((choice) => choice && vscode.env.openExternal(vscode.Uri.parse(PRO.monthlyUrl)));
      }
    }
  }

  /** Prompts for a key and activates it on this machine. */
  async enterKey(): Promise<boolean> {
    const key = (
      await vscode.window.showInputBox({
        title: 'GitHub Actions Live Pro',
        prompt: 'Paste the licence key from your Lemon Squeezy receipt.',
        placeHolder: 'XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
        ignoreFocusOut: true
      })
    )?.trim();
    if (!key) {
      return false;
    }

    let response: LicenseResponse;
    try {
      response = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Activating Pro…' },
        () => call('activate', { license_key: key, instance_name: `VS Code (${vscode.env.appName})` })
      );
    } catch {
      void vscode.window.showErrorMessage('Could not reach Lemon Squeezy. Check the connection and try again.');
      return false;
    }

    if (!response.activated || !response.instance?.id) {
      void vscode.window.showErrorMessage(`This key could not be activated: ${response.error ?? 'unknown error'}.`);
      return false;
    }
    if (!this.belongsToUs(response)) {
      // Give the activation back, so the key keeps its slots for the product it is for.
      await call('deactivate', { license_key: key, instance_id: response.instance.id }).catch(() => undefined);
      void vscode.window.showErrorMessage('This licence key is for a different product.');
      return false;
    }

    await this.context.secrets.store(SECRET_KEY, key);
    await this.context.globalState.update(STATE_KEY, {
      instanceId: response.instance.id,
      status: response.license_key?.status ?? 'active',
      plan: response.meta?.variant_name ?? response.meta?.product_name,
      validatedAt: Date.now()
    } satisfies StoredLicense);
    this.changed.fire(this.isPro);
    void vscode.window.showInformationMessage('Pro is on: CI errors in Problems, notifications, Compare with Last Green and Workflow Health are unlocked. Thank you!');
    return true;
  }

  /** Frees the activation so the key can be used on another machine. */
  async remove(): Promise<void> {
    const stored = this.stored;
    const key = await this.context.secrets.get(SECRET_KEY);
    if (key && stored) {
      await call('deactivate', { license_key: key, instance_id: stored.instanceId }).catch(() => undefined);
    }
    await this.context.secrets.delete(SECRET_KEY);
    await this.context.globalState.update(STATE_KEY, undefined);
    this.changed.fire(this.isPro);
    void vscode.window.showInformationMessage('The Pro licence was removed from this machine.');
  }

  private belongsToUs(response: LicenseResponse): boolean {
    // Until the store is configured no key is ours: fail closed, never open.
    const meta = response.meta;
    return meta?.store_id === PRO.storeId && PRO.productIds.includes(meta?.product_id ?? -1);
  }
}

async function call(action: 'activate' | 'validate' | 'deactivate', body: Record<string, string>): Promise<LicenseResponse> {
  const response = await fetch(`${API}/${action}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  });
  // Lemon Squeezy answers 400/404 with a JSON body that explains the problem.
  return (await response.json()) as LicenseResponse;
}

/**
 * Shown when a free user reaches for a Pro feature: says what they would get,
 * offers the trial once and both plans. Resolves to true if Pro is active afterwards.
 */
export async function offerPro(license: License, feature: string): Promise<boolean> {
  if (license.isPro) {
    return true;
  }
  const trial = `Try free for ${PRO.trialDays} days`;
  const monthly = `Get Pro · ${PRO.monthlyPrice}`;
  const lifetime = `Lifetime · ${PRO.lifetimePrice}`;
  const enter = 'Enter licence key';
  const buttons = license.trialStarted ? [monthly, lifetime, enter] : [trial, monthly, lifetime, enter];
  const choice = await vscode.window.showInformationMessage(
    `${feature} is part of Pro.`,
    { modal: true, detail: `${PRO_FEATURES}\n\nLive runs, logs, re-runs and the status bar stay free.` },
    ...buttons
  );
  if (choice === trial) {
    return license.startTrial();
  } else if (choice === monthly || choice === lifetime) {
    return openCheckout(license, choice === monthly ? 'monthly' : 'lifetime');
  } else if (choice === enter) {
    return license.enterKey();
  }
  return license.isPro;
}

/** Opens the checkout in the browser, then offers to paste the key it emails. */
export async function openCheckout(license: License, plan: 'monthly' | 'lifetime'): Promise<boolean> {
  await vscode.env.openExternal(vscode.Uri.parse(plan === 'monthly' ? PRO.monthlyUrl : PRO.lifetimeUrl));
  const enter = 'Enter licence key';
  const next = await vscode.window.showInformationMessage('The licence key arrives by email right after checkout.', enter);
  return next === enter ? license.enterKey() : false;
}
