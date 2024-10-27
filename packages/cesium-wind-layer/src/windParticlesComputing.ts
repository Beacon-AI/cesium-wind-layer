import { PixelDatatype, PixelFormat, Sampler, Texture, TextureMagnificationFilter, TextureMinificationFilter, Cartesian2 } from 'cesium';
import { WindLayerOptions, WindData } from './types';
import { ShaderManager } from './shaderManager';
import CustomPrimitive from './customPrimitive'

export class WindParticlesComputing {
  context: any;
  options: WindLayerOptions;
  viewerParameters: any;
  windTextures!: {
    U: Texture;
    V: Texture;
  };
  particlesTextures!: {
    previousParticlesPosition: Texture;
    currentParticlesPosition: Texture;
    nextParticlesPosition: Texture;
    postProcessingPosition: Texture;
    particlesSpeed: Texture;
  };
  primitives!: {
    calculateSpeed: CustomPrimitive;
    updatePosition: CustomPrimitive;
    postProcessingPosition: CustomPrimitive;
  };
  private bounds: WindData['bounds'];
  windData: Required<WindData>;

  constructor(context: any, windData: Required<WindData>, options: WindLayerOptions, viewerParameters: any) {
    this.context = context;
    this.options = options;
    this.viewerParameters = viewerParameters;
    this.bounds = windData.bounds;
    this.windData = windData;

    this.createWindTextures();
    this.createParticlesTextures();
    this.createComputingPrimitives();
  }

  createWindTextures() {
    const options = {
      context: this.context,
      width: this.windData.width,
      height: this.windData.height,
      pixelFormat: PixelFormat.RED,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: this.options.flipY ?? false,
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.LINEAR,
        magnificationFilter: TextureMagnificationFilter.LINEAR
      })
    }

    this.windTextures = {
      U: new Texture({
        ...options,
        source: {
          arrayBufferView: new Float32Array(this.windData.u.array)
        }
      }),
      V: new Texture({
        ...options,
        source: {
          arrayBufferView: new Float32Array(this.windData.v.array)
        }
      }),
    };
  }

  createParticlesTextures() {
    const options = {
      context: this.context,
      width: this.options.particlesTextureSize,
      height: this.options.particlesTextureSize,
      pixelFormat: PixelFormat.RGBA,
      pixelDatatype: PixelDatatype.FLOAT,
      flipY: false,
      source: {
        arrayBufferView: new Float32Array(this.options.particlesTextureSize * this.options.particlesTextureSize * 4).fill(0)
      },
      sampler: new Sampler({
        minificationFilter: TextureMinificationFilter.NEAREST,
        magnificationFilter: TextureMagnificationFilter.NEAREST
      })
    }

    this.particlesTextures = {
      previousParticlesPosition: new Texture(options),
      currentParticlesPosition: new Texture(options),
      nextParticlesPosition: new Texture(options),
      postProcessingPosition: new Texture(options),
      particlesSpeed: new Texture(options)
    };
  }

  destroyParticlesTextures() {
    Object.values(this.particlesTextures).forEach(texture => texture.destroy());
  }

  createComputingPrimitives() {
    const dimension = new Cartesian2(this.windData.width, this.windData.height);
    const minimum = new Cartesian2(this.bounds.west, this.bounds.south);
    const maximum = new Cartesian2(this.bounds.east, this.bounds.north);
    const interval = new Cartesian2(
      (maximum.x - minimum.x) / (dimension.x - 1),
      (maximum.y - minimum.y) / (dimension.y - 1)
    );


    this.primitives = {
      calculateSpeed: new CustomPrimitive({
        commandType: 'Compute',
        uniformMap: {
          U: () => this.windTextures.U,
          V: () => this.windTextures.V,
          uRange: () => new Cartesian2(this.windData.u.min, this.windData.u.max),
          vRange: () => new Cartesian2(this.windData.v.min, this.windData.v.max),
          speedRange: () => new Cartesian2(this.windData.speed.min, this.windData.speed.max),
          currentParticlesPosition: () => this.particlesTextures.currentParticlesPosition,
          speedScaleFactor: () => this.viewerParameters.pixelSize * this.options.speedFactor,
          dimension: () => dimension,
          minimum: () => minimum,
          maximum: () => maximum,
          interval: () => interval,
        },
        fragmentShaderSource: ShaderManager.getCalculateSpeedShader(),
        outputTexture: this.particlesTextures.particlesSpeed,
        preExecute: () => {
          const temp = this.particlesTextures.previousParticlesPosition;
          this.particlesTextures.previousParticlesPosition = this.particlesTextures.currentParticlesPosition;
          this.particlesTextures.currentParticlesPosition = this.particlesTextures.postProcessingPosition;
          this.particlesTextures.postProcessingPosition = temp;
          if (this.primitives.calculateSpeed.commandToExecute) {
            this.primitives.calculateSpeed.commandToExecute.outputTexture = this.particlesTextures.particlesSpeed;
          }
        }
      }),

      updatePosition: new CustomPrimitive({
        commandType: 'Compute',
        uniformMap: {
          currentParticlesPosition: () => this.particlesTextures.currentParticlesPosition,
          particlesSpeed: () => this.particlesTextures.particlesSpeed,
        },
        fragmentShaderSource: ShaderManager.getUpdatePositionShader(),
        outputTexture: this.particlesTextures.nextParticlesPosition,
        preExecute: () => {
          if (this.primitives.updatePosition.commandToExecute) {
            this.primitives.updatePosition.commandToExecute.outputTexture = this.particlesTextures.nextParticlesPosition;
          }
        }
      }),

      postProcessingPosition: new CustomPrimitive({
        commandType: 'Compute',
        uniformMap: {
          nextParticlesPosition: () => this.particlesTextures.nextParticlesPosition,
          particlesSpeed: () => this.particlesTextures.particlesSpeed,
          lonRange: () => this.viewerParameters.lonRange,
          latRange: () => this.viewerParameters.latRange,
          dataLonRange: () => new Cartesian2(this.windData.bounds.west, this.windData.bounds.east),
          dataLatRange: () => new Cartesian2(this.windData.bounds.south, this.windData.bounds.north),
          dimension: () => dimension,
          minimum: () => minimum,
          maximum: () => maximum,
          interval: () => interval,
          randomCoefficient: function () {
            return Math.random();
          },
          dropRate: () => this.options.dropRate,
          dropRateBump: () => this.options.dropRateBump,
          useViewerBounds: () => this.options.useViewerBounds // 添加新的 uniform
        },
        fragmentShaderSource: ShaderManager.getPostProcessingPositionShader(),
        outputTexture: this.particlesTextures.postProcessingPosition,
        preExecute: () => {
          if (this.primitives.postProcessingPosition.commandToExecute) {
            this.primitives.postProcessingPosition.commandToExecute.outputTexture = this.particlesTextures.postProcessingPosition;
          }
        }
      })
    };
  }

  updateWindData(data: Required<WindData>) {
    this.windData = data;
    this.windTextures.U.copyFrom({ source: data.u.array });
    this.windTextures.V.copyFrom({ source: data.v.array });
  }

  updateOptions(options: Partial<WindLayerOptions>) {
    const needUpdateWindTextures = options.flipY !== this.options.flipY;
    this.options = { ...this.options, ...options };
    if (needUpdateWindTextures) {
      this.windTextures.U.destroy();
      this.windTextures.V.destroy();
      this.createWindTextures();
    }
  }

  processWindData(data: {
    array: Float32Array;
    min?: number;
    max?: number;
  }): Float32Array {
    const { array } = data;
    let { min, max } = data;
    const result = new Float32Array(array.length);
    if (min === undefined) {
      console.warn('min is undefined, calculate min');
      min = Math.min(...array);
    }
    if (max === undefined) {
      console.warn('max is undefined, calculate max');
      max = Math.max(...array);
    }

    const maxNum = Math.max(Math.abs(min), Math.abs(max));

    for (let i = 0; i < array.length; i++) {
      const value = array[i] / maxNum; // Normalize to [-1, 1]
      result[i] = value;
    }
    console.log(result)
    return result;
  }

  destroy() {
    Object.values(this.windTextures).forEach(texture => texture.destroy());
    Object.values(this.particlesTextures).forEach(texture => texture.destroy());
    Object.values(this.primitives).forEach(primitive => primitive.destroy());
  }
}
