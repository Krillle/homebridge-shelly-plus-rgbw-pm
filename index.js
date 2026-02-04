'use strict';

const PLUGIN_NAME = 'homebridge-shelly-plus-rgbw-pm';
const PLATFORM_NAME = 'ShellyPlusRGBWPM';

module.exports = (api) => {
  api.registerPlatform(PLATFORM_NAME, ShellyPlusRGBWPMPlatform);
};

class ShellyPlusRGBWPMPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.accessories = new Map();
    this.commandQueues = new Map();

    this.pollTimer = null;
    this.pollInFlight = null;

    this.platformName = normalizeName(this.config.name) || 'Shelly Plus RGBW PM';
    this.devices = this.parseConfiguredDevices();

    if (!this.devices.size) {
      this.log.error('No Shelly devices configured. Set "host" or add entries under "devices".');
      return;
    }

    this.api.on('didFinishLaunching', async () => {
      await this.initialize();
    });
  }

  configureAccessory(accessory) {
    accessory.context = accessory.context || {};
    this.accessories.set(accessory.UUID, accessory);
  }

  parseConfiguredDevices() {
    const devices = new Map();
    const configuredDevices = Array.isArray(this.config.devices)
      ? this.config.devices
      : [];

    configuredDevices.forEach((deviceConfig, index) => {
      this.addConfiguredDevice(devices, deviceConfig, {
        fallbackName: `${this.platformName} ${index + 1}`,
        label: `devices[${index}]`,
      });
    });

    if (this.config.host) {
      this.addConfiguredDevice(devices, this.config, {
        fallbackName: this.platformName,
        label: 'host',
      });
    }

    return devices;
  }

  addConfiguredDevice(devices, config, options) {
    const host = sanitizeHost(config ? config.host : '');

    if (!host) {
      if (options && options.label !== 'host') {
        this.log.warn('Ignoring %s because host is missing.', options.label);
      }

      return;
    }

    if (devices.has(host)) {
      this.log.warn('Duplicate Shelly host %s found in config. Ignoring duplicate entry.', host);
      return;
    }

    const displayName = normalizeName(config.name) || options.fallbackName || host;
    const showDimmers = [0, 1, 2, 3].map((channel) => this.isDimmerEnabled(config, channel));

    devices.set(host, {
      host,
      displayName,
      showDimmers,
      client: new ShellyRpcClient(host),
      profile: null,
      deviceInfo: {},
      descriptors: [],
      discovered: false,
    });
  }

  async initialize() {
    try {
      await this.refreshTopology();
    } catch (error) {
      this.log.error('Initial Shelly discovery failed: %s', error.message);
    }

    this.startPolling();
  }

  startPolling(intervalMs = 5000) {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    this.pollTimer = setInterval(async () => {
      try {
        await this.pollSerial();
      } catch (error) {
        this.log.warn('Polling cycle failed: %s', error.message);
      }
    }, intervalMs);

    if (typeof this.pollTimer.unref === 'function') {
      this.pollTimer.unref();
    }
  }

  async poll() {
    const devices = Array.from(this.devices.values());
    await Promise.all(devices.map((device) => this.pollDevice(device)));
  }

  async pollDevice(device) {
    try {
      const status = await device.client.getStatus();
      const nextProfile = determineProfile(status, null);

      if (nextProfile !== device.profile) {
        this.log.info(
          'Shelly %s profile changed from %s to %s. Rebuilding accessories.',
          device.host,
          device.profile || 'unknown',
          nextProfile,
        );
        await this.refreshDeviceTopology(device, { cachedStatus: status });
        return;
      }

      this.updateAccessoryStates(device.host, status);
    } catch (error) {
      this.log.warn('Polling failed for %s: %s', device.host, error.message);
    }
  }

  async pollSerial() {
    if (this.pollInFlight) {
      return this.pollInFlight;
    }

    this.pollInFlight = this.poll().finally(() => {
      this.pollInFlight = null;
    });

    return this.pollInFlight;
  }

  async refreshTopology() {
    const statusesByHost = new Map();
    const devices = Array.from(this.devices.values());

    await Promise.all(devices.map(async (device) => {
      try {
        const status = await this.refreshDeviceTopology(device, { sync: false });
        statusesByHost.set(device.host, status);
      } catch (error) {
        this.log.warn('Shelly discovery failed for %s: %s', device.host, error.message);
      }
    }));

    this.syncAccessories(this.collectDiscoveredDescriptors());

    for (const [host, status] of statusesByHost.entries()) {
      this.updateAccessoryStates(host, status);
    }

    if (!statusesByHost.size) {
      throw new Error('Could not discover any configured Shelly devices.');
    }
  }

  async refreshDeviceTopology(device, options = {}) {
    const { cachedStatus, sync = true } = options;
    const [status, deviceInfo] = await Promise.all([
      cachedStatus ? Promise.resolve(cachedStatus) : device.client.getStatus(),
      device.client.getDeviceInfo().catch((error) => {
        this.log.warn('Shelly.GetDeviceInfo failed for %s: %s', device.host, error.message);
        return {};
      }),
    ]);

    device.deviceInfo = deviceInfo || {};
    device.profile = determineProfile(status, device.deviceInfo.profile);
    device.descriptors = this.buildAccessoryDescriptors(device);
    device.discovered = true;

    if (sync) {
      this.syncAccessories(this.collectDiscoveredDescriptors());
      this.updateAccessoryStates(device.host, status);
    }

    return status;
  }

  collectDiscoveredDescriptors() {
    const descriptors = [];

    for (const device of this.devices.values()) {
      if (!device.discovered) {
        continue;
      }

      descriptors.push(...device.descriptors);
    }

    return descriptors;
  }

  buildAccessoryDescriptors(device) {
    const { host, profile, displayName, showDimmers } = device;

    if (profile === 'light') {
      const descriptors = [];

      for (let channel = 0; channel < 4; channel++) {
        if (!showDimmers[channel]) {
          continue;
        }

        const name = `${displayName} Dimmer ${channel + 1}`;
        descriptors.push({
          host,
          kind: 'light',
          channel,
          name,
          uuid: this.api.hap.uuid.generate(`${host}|light|${channel}`),
        });
      }

      if (!descriptors.length) {
        this.log.warn('Shelly %s is in light profile but all dimmer checkboxes are disabled.', host);
      }

      return descriptors;
    }

    return [{
      host,
      kind: profile,
      channel: 0,
      name: displayName,
      uuid: this.api.hap.uuid.generate(`${host}|${profile}|0`),
    }];
  }

  isDimmerEnabled(config, channel) {
    const key = `showDimmer${channel + 1}`;
    return !config || config[key] !== false;
  }

  inferHostFromUuid(uuid) {
    for (const host of this.devices.keys()) {
      for (let channel = 0; channel < 4; channel++) {
        if (uuid === this.api.hap.uuid.generate(`${host}|light|${channel}`)) {
          return host;
        }
      }

      if (uuid === this.api.hap.uuid.generate(`${host}|rgb|0`)) {
        return host;
      }

      if (uuid === this.api.hap.uuid.generate(`${host}|rgbw|0`)) {
        return host;
      }
    }

    return '';
  }

  getAccessoryHost(accessory) {
    const contextHost = sanitizeHost(accessory.context ? accessory.context.host : '');

    if (contextHost) {
      return contextHost;
    }

    const inferredHost = this.inferHostFromUuid(accessory.UUID);

    if (inferredHost) {
      accessory.context.host = inferredHost;
      return inferredHost;
    }

    return '';
  }

  getAccessoryDevice(accessory) {
    const host = this.getAccessoryHost(accessory);

    if (!host) {
      throw new Error('Accessory host is missing from cached context.');
    }

    const device = this.devices.get(host);

    if (!device) {
      throw new Error(`Shelly host ${host} is not configured.`);
    }

    return device;
  }

  syncAccessories(descriptors) {
    const wanted = new Map(descriptors.map((descriptor) => [descriptor.uuid, descriptor]));

    for (const [uuid, accessory] of this.accessories.entries()) {
      if (wanted.has(uuid)) {
        continue;
      }

      const host = this.getAccessoryHost(accessory);
      const device = host ? this.devices.get(host) : null;

      if (device && !device.discovered) {
        continue;
      }

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.commandQueues.delete(uuid);
      this.log.info('Removed accessory: %s', accessory.displayName);
    }

    for (const descriptor of descriptors) {
      const existing = this.accessories.get(descriptor.uuid);

      if (existing) {
        existing.context.host = descriptor.host;
        existing.context.kind = descriptor.kind;
        existing.context.channel = descriptor.channel;
        existing.context.state = existing.context.state || {};

        if (existing.displayName !== descriptor.name) {
          existing.displayName = descriptor.name;
        }

        this.configureShellyAccessory(existing);
        this.api.updatePlatformAccessories([existing]);
        continue;
      }

      const accessory = new this.api.platformAccessory(
        descriptor.name,
        descriptor.uuid,
        this.api.hap.Categories.LIGHTBULB,
      );

      accessory.context.host = descriptor.host;
      accessory.context.kind = descriptor.kind;
      accessory.context.channel = descriptor.channel;
      accessory.context.state = defaultState(descriptor.kind);

      this.configureShellyAccessory(accessory);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(descriptor.uuid, accessory);
      this.log.info('Added accessory: %s', descriptor.name);
    }
  }

  configureShellyAccessory(accessory) {
    const host = this.getAccessoryHost(accessory);
    const device = host ? this.devices.get(host) : null;
    const deviceInfo = device ? device.deviceInfo : {};

    const information = accessory.getService(this.Service.AccessoryInformation)
      || accessory.addService(this.Service.AccessoryInformation);

    information
      .setCharacteristic(this.Characteristic.Manufacturer, 'Shelly')
      .setCharacteristic(this.Characteristic.Model, deviceInfo.model || 'Shelly Plus RGBW PM')
      .setCharacteristic(this.Characteristic.SerialNumber, deviceInfo.mac || host || 'unknown')
      .setCharacteristic(this.Characteristic.FirmwareRevision, deviceInfo.ver || 'unknown');

    const lightService = accessory.getService(this.Service.Lightbulb)
      || accessory.addService(this.Service.Lightbulb);

    lightService.setCharacteristic(this.Characteristic.Name, accessory.displayName);

    const onCharacteristic = lightService.getCharacteristic(this.Characteristic.On);
    resetCharacteristicHandlers(onCharacteristic);
    onCharacteristic.onGet(() => this.getOn(accessory));
    onCharacteristic.onSet((value) => this.setOn(accessory, value));

    const brightnessCharacteristic = lightService.getCharacteristic(this.Characteristic.Brightness);
    resetCharacteristicHandlers(brightnessCharacteristic);
    brightnessCharacteristic.onGet(() => this.getBrightness(accessory));
    brightnessCharacteristic.onSet((value) => this.setBrightness(accessory, value));

    if (accessory.context.kind === 'light') {
      if (lightService.testCharacteristic(this.Characteristic.Hue)) {
        lightService.removeCharacteristic(lightService.getCharacteristic(this.Characteristic.Hue));
      }

      if (lightService.testCharacteristic(this.Characteristic.Saturation)) {
        lightService.removeCharacteristic(lightService.getCharacteristic(this.Characteristic.Saturation));
      }

      return;
    }

    const hueCharacteristic = lightService.getCharacteristic(this.Characteristic.Hue);
    resetCharacteristicHandlers(hueCharacteristic);
    hueCharacteristic.onGet(() => this.getHue(accessory));
    hueCharacteristic.onSet((value) => this.setHue(accessory, value));

    const saturationCharacteristic = lightService.getCharacteristic(this.Characteristic.Saturation);
    resetCharacteristicHandlers(saturationCharacteristic);
    saturationCharacteristic.onGet(() => this.getSaturation(accessory));
    saturationCharacteristic.onSet((value) => this.setSaturation(accessory, value));
  }

  getState(accessory) {
    if (!accessory.context.state) {
      accessory.context.state = defaultState(accessory.context.kind);
    }

    return accessory.context.state;
  }

  getOn(accessory) {
    return this.getState(accessory).on;
  }

  getBrightness(accessory) {
    return this.getState(accessory).brightness;
  }

  getHue(accessory) {
    return this.getState(accessory).hue;
  }

  getSaturation(accessory) {
    return this.getState(accessory).saturation;
  }

  async setOn(accessory, value) {
    const targetOn = Boolean(value);

    await this.enqueueAccessoryCommand(accessory, async () => {
      const device = this.getAccessoryDevice(accessory);
      const kind = accessory.context.kind;
      const state = this.getState(accessory);

      if (kind === 'light') {
        await device.client.call('Light.Set', {
          id: accessory.context.channel,
          on: targetOn,
        });

        state.on = targetOn;

        if (targetOn && state.brightness <= 0) {
          state.brightness = 100;
        }

        this.pushStateToHomeKit(accessory, state);
        return;
      }

      if (!targetOn) {
        await device.client.call(profileToMethod(kind), { id: 0, on: false });
        state.on = false;
        this.pushStateToHomeKit(accessory, state);
        return;
      }

      if (state.brightness <= 0) {
        state.brightness = 100;
      }

      state.on = true;
      const params = this.buildColorSetParams(kind, state, true);
      await device.client.call(profileToMethod(kind), params);
      this.pushStateToHomeKit(accessory, state);
    });
  }

  async setBrightness(accessory, value) {
    const targetBrightness = clampPercent(value);

    await this.enqueueAccessoryCommand(accessory, async () => {
      const device = this.getAccessoryDevice(accessory);
      const kind = accessory.context.kind;
      const state = this.getState(accessory);

      if (kind === 'light') {
        if (targetBrightness <= 0) {
          await device.client.call('Light.Set', {
            id: accessory.context.channel,
            on: false,
          });

          state.on = false;
          state.brightness = 0;
          this.pushStateToHomeKit(accessory, state);
          return;
        }

        await device.client.call('Light.Set', {
          id: accessory.context.channel,
          on: true,
          brightness: targetBrightness,
        });

        state.on = true;
        state.brightness = targetBrightness;
        this.pushStateToHomeKit(accessory, state);
        return;
      }

      if (targetBrightness <= 0) {
        await device.client.call(profileToMethod(kind), { id: 0, on: false });
        state.on = false;
        state.brightness = 0;
        this.pushStateToHomeKit(accessory, state);
        return;
      }

      state.on = true;
      state.brightness = targetBrightness;
      const params = this.buildColorSetParams(kind, state, true);
      await device.client.call(profileToMethod(kind), params);
      this.pushStateToHomeKit(accessory, state);
    });
  }

  async setHue(accessory, value) {
    const targetHue = clampHue(value);

    await this.enqueueAccessoryCommand(accessory, async () => {
      const device = this.getAccessoryDevice(accessory);
      const kind = accessory.context.kind;
      const state = this.getState(accessory);

      state.hue = targetHue;

      if (!state.on) {
        return;
      }

      const params = this.buildColorSetParams(kind, state, true);
      await device.client.call(profileToMethod(kind), params);
      this.pushStateToHomeKit(accessory, state);
    });
  }

  async setSaturation(accessory, value) {
    const targetSaturation = clampPercent(value);

    await this.enqueueAccessoryCommand(accessory, async () => {
      const device = this.getAccessoryDevice(accessory);
      const kind = accessory.context.kind;
      const state = this.getState(accessory);

      state.saturation = targetSaturation;

      if (!state.on) {
        return;
      }

      const params = this.buildColorSetParams(kind, state, true);
      await device.client.call(profileToMethod(kind), params);
      this.pushStateToHomeKit(accessory, state);
    });
  }

  buildColorSetParams(kind, state, on) {
    const brightness = Math.max(1, clampPercent(state.brightness || 100));
    const hue = clampHue(state.hue);
    const saturation = clampPercent(state.saturation);

    if (kind === 'rgbw' && saturation <= 1) {
      return {
        id: 0,
        on,
        brightness,
        rgb: [0, 0, 0],
        white: percentToByte(brightness),
      };
    }

    const rgb = hsvToRgb(hue, saturation, brightness);

    if (kind === 'rgbw') {
      return {
        id: 0,
        on,
        brightness,
        rgb,
        white: 0,
      };
    }

    return {
      id: 0,
      on,
      brightness,
      rgb,
    };
  }

  enqueueAccessoryCommand(accessory, task) {
    const key = accessory.UUID;
    const previous = this.commandQueues.get(key) || Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.commandQueues.get(key) === next) {
          this.commandQueues.delete(key);
        }
      });

    this.commandQueues.set(key, next);
    return next;
  }

  updateAccessoryStates(host, status) {
    for (const accessory of this.accessories.values()) {
      if (this.getAccessoryHost(accessory) !== host) {
        continue;
      }

      const kind = accessory.context.kind;

      if (kind === 'light') {
        const channel = accessory.context.channel;
        const lightStatus = status[`light:${channel}`];

        if (!lightStatus) {
          continue;
        }

        this.pushStateToHomeKit(accessory, normalizeLightStatus(lightStatus));
        continue;
      }

      if (kind === 'rgb') {
        const rgbStatus = status['rgb:0'];

        if (!rgbStatus) {
          continue;
        }

        this.pushStateToHomeKit(accessory, normalizeRgbStatus(rgbStatus));
        continue;
      }

      if (kind === 'rgbw') {
        const rgbwStatus = status['rgbw:0'];

        if (!rgbwStatus) {
          continue;
        }

        this.pushStateToHomeKit(accessory, normalizeRgbwStatus(rgbwStatus));
      }
    }
  }

  pushStateToHomeKit(accessory, nextState) {
    const state = Object.assign(this.getState(accessory), nextState);
    const service = accessory.getService(this.Service.Lightbulb);

    if (!service) {
      return;
    }

    service.updateCharacteristic(this.Characteristic.On, state.on);
    service.updateCharacteristic(this.Characteristic.Brightness, state.brightness);

    if (accessory.context.kind === 'light') {
      return;
    }

    if (service.testCharacteristic(this.Characteristic.Hue)) {
      service.updateCharacteristic(this.Characteristic.Hue, state.hue);
    }

    if (service.testCharacteristic(this.Characteristic.Saturation)) {
      service.updateCharacteristic(this.Characteristic.Saturation, state.saturation);
    }
  }
}

class ShellyRpcClient {
  constructor(host) {
    this.requestId = 1;
    this.timeoutMs = 4000;

    const base = host.startsWith('http://') || host.startsWith('https://')
      ? host
      : `http://${host}`;

    this.url = `${base.replace(/\/+$/, '')}/rpc`;
  }

  async getStatus() {
    return this.call('Shelly.GetStatus');
  }

  async getDeviceInfo() {
    return this.call('Shelly.GetDeviceInfo');
  }

  async call(method, params) {
    if (typeof fetch !== 'function') {
      throw new Error('Global fetch is not available. Use Node.js 18+ for this plugin.');
    }

    const payload = {
      id: this.requestId++,
      src: 'homebridge',
      method,
    };

    if (params && Object.keys(params).length > 0) {
      payload.params = params;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    let response;

    try {
      response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(`Request timeout calling ${method}`);
      }

      throw new Error(`Network error calling ${method}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} calling ${method}`);
    }

    let body;

    try {
      body = await response.json();
    } catch (error) {
      throw new Error(`Invalid JSON received from ${method}`);
    }

    if (body && body.error) {
      const message = body.error.message || JSON.stringify(body.error);
      throw new Error(`Shelly RPC error for ${method}: ${message}`);
    }

    if (body && Object.prototype.hasOwnProperty.call(body, 'result')) {
      return body.result;
    }

    if (body && Object.prototype.hasOwnProperty.call(body, 'params')) {
      return body.params;
    }

    return body;
  }
}

function determineProfile(status, profileHint) {
  const hint = normalizeProfile(profileHint);

  if (hint) {
    return hint;
  }

  const keys = Object.keys(status || {});

  if (keys.some((key) => key.startsWith('light:'))) {
    return 'light';
  }

  if (keys.includes('rgbw:0')) {
    return 'rgbw';
  }

  if (keys.includes('rgb:0')) {
    return 'rgb';
  }

  throw new Error('Could not determine Shelly profile from status.');
}

function normalizeProfile(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === 'light' || normalized === 'rgb' || normalized === 'rgbw') {
    return normalized;
  }

  return null;
}

function normalizeLightStatus(status) {
  return {
    on: Boolean(status.output),
    brightness: clampPercent(status.brightness ?? (status.output ? 100 : 0)),
    hue: 0,
    saturation: 0,
  };
}

function normalizeRgbStatus(status) {
  const rgb = normalizeRgbArray(status.rgb);
  const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);

  return {
    on: Boolean(status.output),
    brightness: clampPercent(status.brightness ?? hsv.v),
    hue: hsv.h,
    saturation: hsv.s,
  };
}

function normalizeRgbwStatus(status) {
  const rgb = normalizeRgbArray(status.rgb);
  const white = clampByte(status.white ?? 0);
  const hasColor = rgb.some((value) => value > 0);

  const colorHsv = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  const fallbackBrightness = hasColor
    ? colorHsv.v
    : Math.round((white / 255) * 100);

  const brightness = clampPercent(status.brightness ?? fallbackBrightness);

  if (!hasColor && white > 0) {
    return {
      on: Boolean(status.output),
      brightness,
      hue: 0,
      saturation: 0,
    };
  }

  return {
    on: Boolean(status.output),
    brightness,
    hue: colorHsv.h,
    saturation: colorHsv.s,
  };
}

function defaultState(kind) {
  if (kind === 'light') {
    return {
      on: false,
      brightness: 100,
      hue: 0,
      saturation: 0,
    };
  }

  return {
    on: false,
    brightness: 100,
    hue: 0,
    saturation: 0,
  };
}

function profileToMethod(profile) {
  if (profile === 'rgb') {
    return 'RGB.Set';
  }

  if (profile === 'rgbw') {
    return 'RGBW.Set';
  }

  throw new Error(`Unsupported color profile: ${profile}`);
}

function hsvToRgb(h, s, v) {
  const hue = clampHue(h);
  const saturation = clampPercent(s) / 100;
  const value = clampPercent(v) / 100;

  const c = value * saturation;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = value - c;

  let rPrime = 0;
  let gPrime = 0;
  let bPrime = 0;

  if (hue >= 0 && hue < 60) {
    rPrime = c;
    gPrime = x;
  } else if (hue >= 60 && hue < 120) {
    rPrime = x;
    gPrime = c;
  } else if (hue >= 120 && hue < 180) {
    gPrime = c;
    bPrime = x;
  } else if (hue >= 180 && hue < 240) {
    gPrime = x;
    bPrime = c;
  } else if (hue >= 240 && hue < 300) {
    rPrime = x;
    bPrime = c;
  } else {
    rPrime = c;
    bPrime = x;
  }

  return [
    Math.round((rPrime + m) * 255),
    Math.round((gPrime + m) * 255),
    Math.round((bPrime + m) * 255),
  ];
}

function rgbToHsv(r, g, b) {
  const red = clampByte(r) / 255;
  const green = clampByte(g) / 255;
  const blue = clampByte(b) / 255;

  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;

  if (delta !== 0) {
    if (max === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (max === green) {
      hue = 60 * ((blue - red) / delta + 2);
    } else {
      hue = 60 * ((red - green) / delta + 4);
    }
  }

  if (hue < 0) {
    hue += 360;
  }

  const saturation = max === 0 ? 0 : (delta / max) * 100;
  const value = max * 100;

  return {
    h: Math.round(hue),
    s: Math.round(saturation),
    v: Math.round(value),
  };
}

function normalizeRgbArray(rgb) {
  if (!Array.isArray(rgb) || rgb.length < 3) {
    return [255, 255, 255];
  }

  return [
    clampByte(rgb[0]),
    clampByte(rgb[1]),
    clampByte(rgb[2]),
  ];
}

function percentToByte(value) {
  return clampByte(Math.round((clampPercent(value) / 100) * 255));
}

function clampPercent(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(number)));
}

function clampHue(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  if (number >= 360) {
    return 360;
  }

  if (number <= 0) {
    return 0;
  }

  return Math.round(number);
}

function clampByte(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(255, Math.round(number)));
}

function sanitizeHost(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

function normalizeName(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function resetCharacteristicHandlers(characteristic) {
  if (typeof characteristic.removeOnGet === 'function') {
    characteristic.removeOnGet();
  }

  if (typeof characteristic.removeOnSet === 'function') {
    characteristic.removeOnSet();
  }

  if (typeof characteristic.removeAllListeners === 'function') {
    characteristic.removeAllListeners('get');
    characteristic.removeAllListeners('set');
  }
}
