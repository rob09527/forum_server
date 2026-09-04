/**
 * 表情 shortcode 兜底表:node-emoji(gemoji 短名)与 unicode-emoji-json(CLDR slug)
 * 两套词表都解析不到的残余 shortcode → Unicode 字符。
 *
 * 由 src/scripts/import-nodeloc/build-emoji-extra-map.ts 依据 NodeLoc /emojis.json 生成,
 * **请勿手工编辑**;对方新增表情后重跑该脚本即可。生成时间:2026-09-02。
 *
 * 覆盖的都是系统性命名差异(国旗 china→flag_china、血型 a_button_blood_type→a_button、
 * 变音符号 türkiye→flag_turkiye 等),NodeLoc 作为机场/VPS 社区国旗用得很频繁,不能漏。
 */
export const EXTRA_EMOJI_MAP: Record<string, string> = {
  "a_button_blood_type": '🅰️',
  "ab_button_blood_type": '🆎',
  "åland_islands": '🇦🇽',
  "ascension_island": '🇦🇨',
  "b_button_blood_type": '🅱️',
  "bouvet_island": '🇧🇻',
  "ceuta_melilla": '🇪🇦',
  "china": '🇨🇳',
  "clipperton_island": '🇨🇵',
  "cocos_keeling_islands": '🇨🇨',
  "côte_d_ivoire": '🇨🇮',
  "curaçao": '🇨🇼',
  "czechia": '🇨🇿',
  "diego_garcia": '🇩🇬',
  "eswatini": '🇸🇿',
  "european_union": '🇪🇺',
  "france": '🇫🇷',
  "germany": '🇩🇪',
  "heard_mcdonald_islands": '🇭🇲',
  "hong_kong_sar_china": '🇭🇰',
  "in_hole": '⛳',
  "italy": '🇮🇹',
  "macao_sar_china": '🇲🇴',
  "myanmar_burma": '🇲🇲',
  "north_macedonia": '🇲🇰',
  "o_button_blood_type": '🅾️',
  "piñata": '🪅',
  "russia": '🇷🇺',
  "south_korea": '🇰🇷',
  "spain": '🇪🇸',
  "st_martin": '🇲🇫',
  "svalbard_jan_mayen": '🇸🇯',
  "ten": '🔟',
  "tristan_da_cunha": '🇹🇦',
  "türkiye": '🇹🇷',
  "united_kingdom": '🇬🇧',
  "united_states": '🇺🇸',
  "us_outlying_islands": '🇺🇲',
  "yoyo": '🪀',
}
