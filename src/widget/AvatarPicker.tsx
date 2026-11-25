import { useRef, type CSSProperties } from 'react';
import { botAvatarCharacters, botAvatarChoice, botAvatarColors, botAvatarGraphics } from '../../shared/bot-avatar';
import { BotAvatar } from '../avatars/BotAvatar';

export function AvatarPicker({ avatar }: { avatar: string }) {
  const choice = botAvatarChoice(avatar);
  const last = useRef({ character: 'drop', graphic: 'waves' });
  last.current[choice.kind] = choice.figure;
  const figures = choice.kind === 'character' ? botAvatarCharacters : botAvatarGraphics;
  const choose = (figure: string, color: string) => void window.echoBuddy.setAvatar(figure + ':' + color);
  return <section className="settings-section">
    <div className="row settings-inline-row">
      <h2>图标样式</h2>
      <div className="switch" role="group" aria-label="图标类别">
        <button aria-pressed={choice.kind === 'character'} onClick={() => choose(last.current.character, choice.color)}>角色</button>
        <button aria-pressed={choice.kind === 'graphic'} onClick={() => choose(last.current.graphic, choice.color)}>图形</button>
      </div>
    </div>
    <div className="figures" role="group" aria-label="选择图标">
      {figures.map(item => <button key={item.id} title={item.name} aria-label={item.name}
        aria-pressed={item.id === choice.figure} onClick={() => choose(item.id, choice.color)}>
        <BotAvatar avatar={item.id + ':' + choice.color} />
      </button>)}
    </div>
    <div className="swatches" role="group" aria-label="图标颜色">
      {botAvatarColors.map(color => <button key={color.id} title={color.name} aria-label={color.name}
        aria-pressed={color.id === choice.color} style={{ '--swatch': color.base } as CSSProperties}
        onClick={() => choose(choice.figure, color.id)} />)}
    </div>
  </section>;
}
