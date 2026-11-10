'use client';
import { useId, useMemo } from 'react';
import { Avatar, Style } from '@dicebear/core';
import glyphsDefinition from '../../../../shared/vendor/dicebear/glyphs.json';
import type { AgentAvatar as Identity } from '../../../../shared/v2/contracts';
import { avatarFromId } from '../../../../shared/v2/agents';
import './agent-avatar.css';
let style: Style | undefined;
const avatarStyle = () => (style ??= new Style(glyphsDefinition));
/** Glyphs by Matt Houser, CC BY 4.0. Only the white base changes to our theme surface. */
export function AgentAvatar({
  avatar,
  id = '',
  size = 30,
}: {
  avatar?: Identity;
  id?: string;
  size?: number;
}) {
  const identity = avatar ?? avatarFromId(id);
  const instance = useId().replaceAll(':', '');
  const svg = useMemo(
    () =>
      new Avatar(avatarStyle(), {
        seed: `${identity.glyph}-${identity.color}`,
        shapeVariant: [identity.glyph as keyof typeof glyphsDefinition.components.shape.variants],
        glyphColor: [identity.color.replace('#', '')],
      })
        .toString()
        .replaceAll('fill="white"', 'fill="var(--ds-surface)"')
        .replace(/id="([^"]+)"/g, `id="$1-${instance}"`)
        .replace(/url\(#([^)]+)\)/g, `url(#$1-${instance})`)
        .replace(/href="#([^"]+)"/g, `href="#$1-${instance}"`),
    [identity.glyph, identity.color, instance],
  );
  return (
    <span
      className="dl-agent-avatar"
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
