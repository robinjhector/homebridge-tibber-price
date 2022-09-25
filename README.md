# Homebridge Tibber Price

A simple homebridge plugin that will display prices from your Tibber account, in various forms. (See screenshot further down)


### Accessory: Actual price
Shows the price, in the smallest denominator of the currency (öre, cents, etc).
This accessory will manifest itself as a light sensor, since there is no "energy meter" accessory type in Apple Home. 

The accessory will display `cents` as `lux`. Can be hooked up to automation rules.

### Accessory: Relative price
Shows the _relative_ price, in percentage across the day. Compares the current price with the highest point of the day.
This accessory will manifest itself as a humidity sensor, since there is no "energy meter" accessory type in Apple Home.

The accessory will display `%`. Can be hooked up to automation rules.


### Price graphing
The plugin can also generate a `.png` image, graphing todays prices (and tomorrows, if available).
The image will be rendered at 1280x720 pixels. Rendering will be done by an https call to [Quickchart.io](https://quickchart.io/)

In order for this to show up in Apple Home in any meaningful way, you can utilise [Homebridge Camera FFmpeg](https://github.com/Sunoo/homebridge-camera-ffmpeg) plugin to "stream" the image, as a camera accessory.


#### Configuring
Configure via the Homebridge Config UI.

#### Configuring ffmpeg camera plugin
Configure the camera via Homebridge Config UI, and enter this under `Video Source`:
```
-f image2 -loop 1 -s 1280x720 -pix_fmt yuvj422p -i <PATH_TO_HOMEBRIDGE_INSTALLATION>/.homebridge/tibber-price/price-chart.png
```

This works fine for me, but ffmpeg has a lot of configuration options, so feel free to experiment.

**Don't forget to replace PATH_TO_HOMEBRIDGE_INSTALLATION with the actual location**

### Preview (from an iPad)

![IMG_0002](https://user-images.githubusercontent.com/28866344/192147509-71492bf2-649a-4806-b2b9-978d67f48f7f.PNG)

### Rendered graph:

![price-chart](https://user-images.githubusercontent.com/28866344/192149351-403b56e5-afa8-41e2-bccc-670946bcd290.png)

