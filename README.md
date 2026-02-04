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

- **Display Name** (required)
- **Shelly Devices** (required): add one entry per Shelly Plus RGBW PM device

Per device options:

- **Device Name**: name you want to see for this device in Homebridge.
- **IP Address or mDNS Name**: the mDNS name is persistent even in a DHCP-based IP environment. You can find the device ID at `http://<device-ip-address>/shelly` (field `id`). Append `.local` to that ID to obtain the mDNS hostname.
- **Show Dimmer O1** / **O2** / **O3** / **O4**: for Shelly Plus RGBW PM devices in light mode, select the dimmers you want to see as devices in Homebridge. If the device is in RGBW or RGB mode, these checkboxes are ignored.

## Example config.json

```json
{
  "platforms": [
    {
      "platform": "ShellyPlusRGBWPM",
      "name": "Shelly Plus RGBW PM",
      "devices": [
        {
          "name": "Kitchen Lights",
          "host": "shellyplusrgbwpm-kitchen.local",
          "showDimmer1": true,
          "showDimmer2": true,
          "showDimmer3": false,
          "showDimmer4": false
        },
        {
          "name": "Patio Lights",
          "host": "shellyplusrgbwpm-patio.local",
          "showDimmer1": true,
          "showDimmer2": true,
          "showDimmer3": true,
          "showDimmer4": true
        }
      ]
    }
  ]
}
```

## Notes

- The plugin polls the device every 5 seconds.
- If the Shelly profile changes (for example `light` to `rgbw`), the plugin rebuilds accessories automatically.
- RGBW white output is mapped to HomeKit by using low saturation (`Saturation = 0`) as white mode.
