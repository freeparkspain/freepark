import { parkingClusterSignature } from '../utils/parkingCluster';
import { OsmParking } from '../types/parking';

function parking(id: string, latitude: number, longitude: number): OsmParking {
  return { id, position: { latitude, longitude }, polygon: null, polyline: null, tags: {} };
}

describe('parkingClusterSignature', () => {
  it('changes for equal-length datasets with different IDs', () => {
    expect(parkingClusterSignature([parking('a', 1, 2)]))
      .not.toBe(parkingClusterSignature([parking('b', 1, 2)]));
  });

  it('changes when a parking moves', () => {
    expect(parkingClusterSignature([parking('a', 1, 2)]))
      .not.toBe(parkingClusterSignature([parking('a', 3, 4)]));
  });

  it('ignores geometry and tag-only updates', () => {
    const first = parking('a', 1, 2);
    const updated = { ...first, polygon: [{ latitude: 1, longitude: 2 }], tags: { fee: 'no' } };
    expect(parkingClusterSignature([first])).toBe(parkingClusterSignature([updated]));
  });
});
