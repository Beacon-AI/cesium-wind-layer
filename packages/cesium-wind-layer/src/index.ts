import {
  Viewer,
  Scene,
  Cartesian2,
  SceneMode,
  Math as CesiumMath,
  Rectangle
} from 'cesium';

import { WindLayerOptions, WindData, WindDataAtLonLat } from './types';
import { WindParticleSystem } from './windParticleSystem';

export * from './types';

type WindLayerEventType = 'dataChange' | 'optionsChange';
type WindLayerEventCallback = (data: WindData | WindLayerOptions) => void;

export class WindLayer {
  private _show: boolean = true;
  private _resized: boolean = false;
  windData: Required<WindData>;

  get show(): boolean {
    return this._show;
  }

  set show(value: boolean) {
    if (this._show !== value) {
      this._show = value;
      this.updatePrimitivesVisibility(value);
    }
  }

  static defaultOptions: WindLayerOptions = {
    particlesTextureSize: 100,
    dropRate: 0.003,
    particleHeight: 1000,
    dropRateBump: 0.01,
    speedFactor: 1.0,
    lineWidth: 10.0,
    colors: ['white'],
    flipY: false,
    useViewerBounds: false // 默认使用全局范围
  }

  viewer: Viewer;
  scene: Scene;
  options: WindLayerOptions;
  private particleSystem: WindParticleSystem;
  private viewerParameters: {
    lonRange: Cartesian2;
    latRange: Cartesian2;
    pixelSize: number;
    sceneMode: SceneMode;
  };
  private _isDestroyed: boolean = false;
  private primitives: any[] = [];
  private eventListeners: Map<WindLayerEventType, Set<WindLayerEventCallback>> = new Map();

  /**
   * WindLayer class for visualizing wind field data with particle animation in Cesium.
   * 
   * @class
   * @param {Viewer} viewer - The Cesium viewer instance.
   * @param {WindData} windData - The wind field data to visualize.
   * @param {Partial<WindLayerOptions>} [options] - Optional configuration options for the wind layer.
   * @param {number} [options.particlesTextureSize=100] - Size of the particle texture. Determines the maximum number of particles (size squared).
   * @param {number} [options.particleHeight=0] - Height of particles above the ground in meters.
   * @param {number} [options.lineWidth=3.0] - Width of particle trails in pixels.
   * @param {number} [options.speedFactor=1.0] - Factor to adjust the speed of particles.
   * @param {number} [options.dropRate=0.003] - Rate at which particles are dropped (reset).
   * @param {number} [options.dropRateBump=0.001] - Additional drop rate for slow-moving particles.
   * @param {string[]} [options.colors=['white']] - Array of colors for particles. Can be used to create color gradients.
   * @param {boolean} [options.flipY=false] - Whether to flip the Y-axis of the wind data.
   * @param {boolean} [options.useViewerBounds=false] - Whether to use the viewer bounds to generate particles.
   */
  constructor(viewer: Viewer, windData: WindData, options?: Partial<WindLayerOptions>) {
    this.show = true;
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.options = { ...WindLayer.defaultOptions, ...options };
    this.windData = this.processWindData(windData);

    this.viewerParameters = {
      lonRange: new Cartesian2(-180, 180),
      latRange: new Cartesian2(-90, 90),
      pixelSize: 1000.0,
      sceneMode: this.scene.mode
    };
    this.updateViewerParameters();

    this.particleSystem = new WindParticleSystem(this.scene.context, this.windData, this.options, this.viewerParameters);
    this.add();

    this.setupEventListeners();
  }

  private setupEventListeners(): void {
    this.viewer.camera.percentageChanged = 0.01;
    this.viewer.camera.changed.addEventListener(this.updateViewerParameters.bind(this));
    this.scene.morphComplete.addEventListener(this.updateViewerParameters.bind(this));
    window.addEventListener("resize", this.updateViewerParameters.bind(this));
  }

  private removeEventListeners(): void {
    this.viewer.camera.changed.removeEventListener(this.updateViewerParameters.bind(this));
    this.scene.morphComplete.removeEventListener(this.updateViewerParameters.bind(this));
    window.removeEventListener("resize", this.updateViewerParameters.bind(this));
  }

  private processWindData(windData: WindData): Required<WindData> {
    if (windData.speed?.min === undefined || windData.speed?.max === undefined) {
      console.info('no speed data, calculate speed...');
      const speed = {
        array: new Float32Array(windData.u.array.length),
        min: Number.MAX_VALUE,
        max: Number.MIN_VALUE
      };
      for (let i = 0; i < windData.u.array.length; i++) {
        speed.array[i] = Math.sqrt(windData.u.array[i] * windData.u.array[i] + windData.v.array[i] * windData.v.array[i]);
        if (speed.array[i] !== 0) {
          speed.min = Math.min(speed.min, speed.array[i]);
          speed.max = Math.max(speed.max, speed.array[i]);
        }
      }
      return {
        ...windData,
        speed
      }
    }
    return windData as Required<WindData>;
  }

  /**
   * Get the wind data at a specific longitude and latitude.
   * @param {number} lon - The longitude.
   * @param {number} lat - The latitude.
   * @returns {Object} - An object containing the u, v, and speed values at the specified coordinates.
   */
  getDataAtLonLat(lon: number, lat: number): WindDataAtLonLat | null {
    const { bounds, width, height, u, v, speed } = this.windData;
    const { flipY } = this.options;

    // Check if the coordinates are within bounds
    if (lon < bounds.west || lon > bounds.east || lat < bounds.south || lat > bounds.north) {
      return null;
    }

    // Calculate normalized coordinates
    const xNorm = (lon - bounds.west) / (bounds.east - bounds.west) * (width - 1);
    let yNorm = (lat - bounds.south) / (bounds.north - bounds.south) * (height - 1);

    // Apply flipY if enabled
    if (flipY) {
      yNorm = height - 1 - yNorm;
    }

    // Get exact grid point for original values
    const x = Math.floor(xNorm);
    const y = Math.floor(yNorm);

    // Get the four surrounding grid points for interpolation
    const x0 = Math.floor(xNorm);
    const x1 = Math.min(x0 + 1, width - 1);
    const y0 = Math.floor(yNorm);
    const y1 = Math.min(y0 + 1, height - 1);

    // Calculate interpolation weights
    const wx = xNorm - x0;
    const wy = yNorm - y0;

    // Get indices
    const index = y * width + x;
    const i00 = y0 * width + x0;
    const i10 = y0 * width + x1;
    const i01 = y1 * width + x0;
    const i11 = y1 * width + x1;

    // Bilinear interpolation for u component
    const u00 = u.array[i00];
    const u10 = u.array[i10];
    const u01 = u.array[i01];
    const u11 = u.array[i11];
    const uInterp = (1 - wx) * (1 - wy) * u00 + wx * (1 - wy) * u10 +
      (1 - wx) * wy * u01 + wx * wy * u11;

    // Bilinear interpolation for v component
    const v00 = v.array[i00];
    const v10 = v.array[i10];
    const v01 = v.array[i01];
    const v11 = v.array[i11];
    const vInterp = (1 - wx) * (1 - wy) * v00 + wx * (1 - wy) * v10 +
      (1 - wx) * wy * v01 + wx * wy * v11;

    // Calculate interpolated speed
    const interpolatedSpeed = Math.sqrt(uInterp * uInterp + vInterp * vInterp);

    return {
      original: {
        u: u.array[index],
        v: v.array[index],
        speed: speed.array[index],
      },
      interpolated: {
        u: uInterp,
        v: vInterp,
        speed: interpolatedSpeed,
      }
    };
  }

  private updateViewerParameters(): void {
    const scene = this.viewer.scene;
    const canvas = scene.canvas;
    const corners = [
      { x: 0, y: 0 },
      { x: 0, y: canvas.clientHeight },
      { x: canvas.clientWidth, y: 0 },
      { x: canvas.clientWidth, y: canvas.clientHeight }
    ];

    // Convert screen corners to cartographic coordinates
    let minLon = 180;
    let maxLon = -180;
    let minLat = 90;
    let maxLat = -90;
    let isOutsideGlobe = false;

    for (const corner of corners) {
      const cartesian = scene.camera.pickEllipsoid(
        new Cartesian2(corner.x, corner.y),
        scene.globe.ellipsoid
      );

      if (!cartesian) {
        isOutsideGlobe = true;
        break;
      }

      const cartographic = scene.globe.ellipsoid.cartesianToCartographic(cartesian);
      const lon = CesiumMath.toDegrees(cartographic.longitude);
      const lat = CesiumMath.toDegrees(cartographic.latitude);

      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }

    if (!isOutsideGlobe) { // -30 degrees in radians
      // Calculate intersection with data bounds
      const lonRange = new Cartesian2(
        Math.max(this.windData.bounds.west, minLon),
        Math.min(this.windData.bounds.east, maxLon)
      );
      const latRange = new Cartesian2(
        Math.max(this.windData.bounds.south, minLat),
        Math.min(this.windData.bounds.north, maxLat)
      );

      // Add 5% buffer to lonRange and latRange
      const lonBuffer = (lonRange.y - lonRange.x) * 0.05;
      const latBuffer = (latRange.y - latRange.x) * 0.05;

      lonRange.x = Math.max(this.windData.bounds.west, lonRange.x - lonBuffer);
      lonRange.y = Math.min(this.windData.bounds.east, lonRange.y + lonBuffer);
      latRange.x = Math.max(this.windData.bounds.south, latRange.x - latBuffer);
      latRange.y = Math.min(this.windData.bounds.north, latRange.y + latBuffer);

      this.viewerParameters.lonRange = lonRange;
      this.viewerParameters.latRange = latRange;
      // Calculate pixelSize based on the visible range
      const dataLonRange = this.windData.bounds.east - this.windData.bounds.west;
      const dataLatRange = this.windData.bounds.north - this.windData.bounds.south;

      // Calculate the ratio of visible area to total data area based on the shortest side
      const visibleRatioLon = (lonRange.y - lonRange.x) / dataLonRange;
      const visibleRatioLat = (latRange.y - latRange.x) / dataLatRange;
      const visibleRatio = Math.min(visibleRatioLon, visibleRatioLat);

      // Map the ratio to a pixelSize value between 0 and 1000
      const pixelSize = 1000 * visibleRatio;
      if (pixelSize > 0) {
        this.viewerParameters.pixelSize = Math.max(0, Math.min(1000, pixelSize));
      }
    }


    this.viewerParameters.sceneMode = this.scene.mode;
    this.particleSystem?.applyViewerParameters(this.viewerParameters);
  }

  /**
   * Update the wind data of the wind layer.
   * @param {WindData} data - The new wind data to apply.
   */
  updateWindData(data: WindData): void {
    this.windData = this.processWindData(data);
    this.particleSystem.computing.updateWindData(this.windData);
    this.viewer.scene.requestRender();
    // Dispatch data change event
    this.dispatchEvent('dataChange', this.windData);
  }

  /**
   * Update the options of the wind layer.
   * @param {Partial<WindLayerOptions>} options - The new options to apply.
   */
  updateOptions(options: Partial<WindLayerOptions>): void {
    this.options = { ...this.options, ...options };
    this.particleSystem.changeOptions(options);
    this.viewer.scene.requestRender();
    // Dispatch options change event
    this.dispatchEvent('optionsChange', this.options);
  }

  zoomTo(duration: number = 0): void {
    if (this.windData.bounds) {
      const rectangle = Rectangle.fromDegrees(
        this.windData.bounds.west,
        this.windData.bounds.south,
        this.windData.bounds.east,
        this.windData.bounds.north
      );
      this.viewer.camera.flyTo({
        destination: rectangle,
        duration,
      });
    }
  }

  add(): void {
    this.primitives = this.particleSystem.getPrimitives();
    this.primitives.forEach(primitive => {
      this.scene.primitives.add(primitive);
    });
  }

  remove(): void {
    this.primitives.forEach(primitive => {
      this.scene.primitives.remove(primitive);
    });
    this.primitives = [];
  }

  isDestroyed(): boolean {
    return this._isDestroyed;
  }

  destroy(): void {
    this.remove();
    this.removeEventListeners();
    this.particleSystem.destroy();
    // Clear all event listeners
    this.eventListeners.clear();
    this._isDestroyed = true;
  }

  private updatePrimitivesVisibility(visibility?: boolean): void {
    const show = visibility !== undefined ? visibility : this._show;
    this.primitives.forEach(primitive => {
      primitive.show = show;
    });
  }

  addEventListener(type: WindLayerEventType, callback: WindLayerEventCallback) {
    if (!this.eventListeners.has(type)) {
      this.eventListeners.set(type, new Set());
    }
    this.eventListeners.get(type)?.add(callback);
  }

  removeEventListener(type: WindLayerEventType, callback: WindLayerEventCallback) {
    this.eventListeners.get(type)?.delete(callback);
  }

  private dispatchEvent(type: WindLayerEventType, data: WindData | WindLayerOptions) {
    this.eventListeners.get(type)?.forEach(callback => callback(data));
  }

}

export type { WindLayerOptions, WindData, WindLayerEventType, WindLayerEventCallback };
