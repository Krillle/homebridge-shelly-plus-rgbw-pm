# homebridge-shelly-plus-rgbw-pm

Homebridge platform plugin for **Shelly Plus RGBW PM**.

It automatically detects the device profile and exposes accessories like this:

- `light` profile: up to 4 dimmer accessories (`Light.Set`, `Light.GetStatus`)
- `rgb` profile: 1 color light accessory (`RGB.Set`, `RGB.GetStatus`)
- `rgbw` profile: 1 color light accessory (`RGBW.Set`, `RGBW.GetStatus`)

Profile detection is based on Shelly Gen2 RPC status/device info:

- `Shelly.GetStatus`
- `Shelly.GetDeviceInfo`

Device API reference used: [Shelly Plus RGBW PM docs](https://shelly-api-docs.shelly.cloud/gen2/Devices/Gen2/ShellyPlusRGBWPM)

## Install

```bash
npm install -g homebridge-shelly-plus-rgbw-pm
```

## Homebridge UI setup

In Homebridge Config UI X, add platform **Shelly Plus RGBW PM** and set:

- **IP Address or mDNS Name** (required)
- **Display Name** (required)

Optional (used only when the Shelly profile is `light`):

- **Show Dimmer 1**
- **Show Dimmer 2**
- **Show Dimmer 3**
- **Show Dimmer 4**

## Example config.json

```json
{
  "platforms": [
    {
      "platform": "ShellyPlusRGBWPM",
      "name": "Kitchen Lights",
      "host": "shellyplusrgbwpm.local",
      "showDimmer1": true,
      "showDimmer2": true,
      "showDimmer3": false,
      "showDimmer4": false
    }
  ]
}
```

## Notes

- The plugin polls the device every 5 seconds.
- If the Shelly profile changes (for example `light` to `rgbw`), the plugin rebuilds accessories automatically.
- RGBW white output is mapped to HomeKit by using low saturation (`Saturation = 0`) as white mode.
