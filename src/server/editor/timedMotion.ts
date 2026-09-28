import type { ClipZoom, RenderSettings } from '@/types/editor';
import type { PlannedSegment } from './render';
import { intersectRanges, motionRampSeconds } from '@/lib/editor/timedEffects';

/** Registers keep the per-frame expressions small enough for long timelines. */
export function timedMotionChain(segment: PlannedSegment, settings: RenderSettings, direction: ClipZoom, amount: number): string {
  const { width, height, fps } = settings;
  const span = Math.max(1, segment.frames - 1);
  const base = direction === 'none' || amount <= 0 ? '1' : direction === 'out' ? '(1+'+amount+'-on/'+span+'*'+amount+')' : '(1+on/'+span+'*'+amount+')';
  const ranges = intersectRanges(settings.motionRanges, segment.startSeconds, segment.endSeconds);
  const coordinates = (axis: 'x' | 'y', sign: number) => {
    const size = axis === 'x' ? width : height;
    let expression = '('+size+'/2'+(sign > 0 ? '+' : '-')+size+'/(2*'+base+'))';
    for (const r of [...ranges].reverse()) {
      const start = Math.max(segment.startSeconds, Math.round(r.start*fps)/fps);
      const end = Math.min(segment.endSeconds, Math.round(r.end*fps)/fps);
      if (end <= start) continue;
      const localStart = start-segment.startSeconds;
      const localEnd = end-segment.startSeconds;
      const t = '(on/'+fps+')';
      const length = end-start;
      const ramp = motionRampSeconds(length);
      const smooth = (v:string) => '('+v+'*'+v+'*(3-2*'+v+'))';
      const intro = 'min(1,max(0,('+t+'-'+localStart+')/'+ramp+'))';
      const outro = 'min(1,max(0,('+localEnd+'-'+t+')/'+ramp+'))';
      const setup = 'st(0,min(1,max(0,('+t+'-'+localStart+')/'+length+')));' +
        'st(1,'+smooth('ld(0)')+');st(2,'+smooth(intro)+'*'+smooth(outro)+');' +
        'st(3,'+base+'+ld(2)*(1+'+r.amount+(r.effect === 'panZoom' ? '+'+r.amount+'*ld(1)' : '')+'-'+base+'));' +
        'st(4,(1-1/ld(3))*0.4);';
      const vertical = r.direction === 'up' || r.direction === 'down';
      const polarity = r.direction === 'left' || r.direction === 'up' ? 1 : -1;
      const travel = r.effect === 'drift' ? 'sin(ld(0)*2*PI)' : '(2*ld(1)-1)';
      const shift = (axis === 'y') === vertical ? travel+'*ld(4)*ld(2)*'+polarity : axis === 'y' && r.effect === 'drift' ? 'sin(ld(0)*PI)*ld(4)*ld(2)' : '0';
      const value = setup + size+'*(0.5+('+shift+'))'+(sign > 0 ? '+' : '-')+size+'/(2*ld(3))';
      expression = 'if(gte('+t+','+localStart+')*lt('+t+','+localEnd+'),'+value+','+expression+')';
    }
    return expression;
  };
  return 'perspective=' + ['x0','y0','x1','y1','x2','y2','x3','y3'].map((name,i)=>name+"='"+coordinates(i%2 ? 'y' : 'x', (i%2 ? i>=4 : i%4>=2) ? 1 : -1)+"'").join(':') + ':sense=source:eval=frame:interpolation=cubic';
}
