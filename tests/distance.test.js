import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, isInsideRadius } from '../lib/distance.js';

test('distanceMeters returns zero for identical coordinates', () => {
  assert.equal(distanceMeters(31.5204, 74.3587, 31.5204, 74.3587), 0);
});

test('distanceMeters calculates a known equatorial distance', () => {
  const distance = distanceMeters(0, 0, 0, 1);
  assert.ok(Math.abs(distance - 111195.08) < 1);
});

test('isInsideRadius rejects invalid and outside coordinates', () => {
  assert.deepEqual(isInsideRadius({ g_lat: null, g_lng: 74 }, { lat: 31, lng: 74, radius_m: 1000 }), {
    distance: null,
    inside: false
  });
  assert.equal(isInsideRadius({ g_lat: 31.1, g_lng: 74 }, { lat: 31, lng: 74, radius_m: 1000 }).inside, false);
});
