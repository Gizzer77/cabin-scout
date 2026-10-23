/* Trail-camera and security-camera presets. Numbers are TYPICAL published figures, rounded: check your own box or manual and edit them in the app.
   fov = how wide the picture is (degrees), rangeFt = how far it senses/sees, kind = what sort of camera. */
const MODELS = [
  { brand: 'Generic', model: 'Standard trail cam', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Generic', model: 'Wide-angle trail cam', fov: 100, rangeFt: 70, kind: 'trail' },
  { brand: 'Generic', model: 'Cellular trail cam', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Reconyx', model: 'HyperFire 2', fov: 42, rangeFt: 80, kind: 'trail' },
  { brand: 'Browning', model: 'Strike Force', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Browning', model: 'Recon Force', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Spypoint', model: 'Flex', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Spypoint', model: 'Force', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Tactacam', model: 'Reveal', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Moultrie', model: 'Edge / Mobile', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Stealth Cam', model: 'Fusion / DS4K', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Bushnell', model: 'Core / CelluCORE', fov: 55, rangeFt: 80, kind: 'trail' },
  { brand: 'Cuddeback', model: 'Cuddelink / Black Flash', fov: 52, rangeFt: 80, kind: 'trail' },
  { brand: 'Wildgame Innovations', model: 'Terra / Lightsout', fov: 52, rangeFt: 70, kind: 'trail' },
  { brand: 'Kangaroo', model: 'Security camera', fov: 110, rangeFt: 30, kind: 'security' },
  { brand: 'Generic', model: 'Security / doorbell camera', fov: 120, rangeFt: 30, kind: 'security' },
];
module.exports = { MODELS };
