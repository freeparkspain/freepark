import { generateInstruction } from '../services/navigation/instructionGenerator';

const hasCyrillic = (s: string) => /[а-яА-ЯёЁ]/.test(s);

describe('English instruction generator', () => {
  it('turn left onto a named street', () => {
    expect(generateInstruction({ type: 'turn', modifier: 'left', streetName: 'Calle Montaño' }))
      .toBe('Turn left onto Calle Montaño');
  });

  it('turn right without a street name', () => {
    expect(generateInstruction({ type: 'turn', modifier: 'right' })).toBe('Turn right');
  });

  it('slight left → bear left', () => {
    expect(generateInstruction({ type: 'turn', modifier: 'slight left' })).toBe('Bear left');
  });

  it('continue straight', () => {
    expect(generateInstruction({ type: 'continue', modifier: 'straight' })).toBe('Continue straight');
  });

  it('roundabout with an exit number', () => {
    expect(generateInstruction({ type: 'roundabout', exit: 2 }))
      .toBe('At the roundabout, take the second exit');
  });

  it('depart with a street', () => {
    expect(generateInstruction({ type: 'depart', streetName: 'Main St' })).toBe('Head out on Main St');
  });

  it('arrive', () => {
    expect(generateInstruction({ type: 'arrive' })).toBe('You have arrived at your destination');
  });

  it('end of road turning right', () => {
    expect(generateInstruction({ type: 'end of road', modifier: 'right', streetName: 'Oak Ave' }))
      .toBe('At the end of the road, turn right onto Oak Ave');
  });

  it('never produces an empty string for an unknown maneuver', () => {
    expect(generateInstruction({ type: 'notification' }).length).toBeGreaterThan(0);
  });

  it('contains no Russian text', () => {
    const samples = [
      generateInstruction({ type: 'turn', modifier: 'left', streetName: 'Calle Montaño' }),
      generateInstruction({ type: 'roundabout', exit: 3 }),
      generateInstruction({ type: 'arrive' }),
      generateInstruction({ type: 'merge', modifier: 'right' }),
      generateInstruction({ type: 'fork', modifier: 'left' }),
    ];
    samples.forEach((s) => expect(hasCyrillic(s)).toBe(false));
  });
});
