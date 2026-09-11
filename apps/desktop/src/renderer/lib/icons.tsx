/**
 * Icon adapter layer.
 *
 * Primary:  @tabler/icons-react  (all general-purpose icons)
 * Fallback: react-icons         (Tabler-uncovered sets: Phosphor, Remix, brand icons)
 *
 * Convention:
 *   - Tabler icons are re-exported under their original PascalCase name (e.g. IconX).
 *   - Commonly used icons get a shorthand alias (e.g. XIcon = IconX) for brevity.
 *   - react-icons icons are prefixed per set: Pi*, Ri*, Si*, Vsc*.
 *
 * Usage in components:
 *   import { IconX, IconSettings, IconBolt } from "@renderer/lib/icons.js";
 *   <IconX size={16} className="text-content-muted" />
 */

/* ───────── Tabler icons (primary) ───────── */
export type { IconProps as TablerIconProps } from "@tabler/icons-react";

export {
  // Actions
  IconX,
  IconCheck,
  IconPlus,
  IconMinus,
  IconEdit,
  IconTrash,
  IconCopy,
  IconSearch,
  IconFilter,
  IconDownload,
  IconUpload,
  IconRefresh,
  IconEraser,
  IconShare,
  IconSend,
  IconSend2,
  IconArchive,
  IconPin,
  IconPinFilled,
  IconPinnedFilled,
  IconFocus,
  // Navigation
  IconChevronDown,
  IconChevronUp,
  IconChevronLeft,
  IconChevronRight,
  IconArrowRight,
  IconArrowLeft,
  IconArrowUp,
  IconArrowDown,
  IconArrowsExchange,
  IconArrowsMaximize,
  IconArrowsMinimize,
  IconMenu2,
  IconDots,
  IconDotsVertical,
  // Status / feedback
  IconInfoCircle,
  IconAlertCircle,
  IconCircle,
  IconMessageChatbot,
  IconQuote,
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleXFilled,
  IconLoader2,
  IconActivity,
  // Media / content
  IconPlayerPlay,
  IconPlayerStop,
  IconPlayerPause,
  IconPlayerSkipForward,
  IconBolt,
  IconStar,
  IconTools,
  IconPrompt,
  IconStethoscope,
  IconHeart,
  IconEye,
  IconEyeOff,
  IconCode,
  IconTerminal2,
  IconTerminal,
  IconFile,
  IconFileText,
  IconPackage,
  IconPuzzle,
  IconFilePlus,
  IconFileSearch,
  IconFileImport,
  IconFileZip,
  IconPhoto,
  IconPhotoOff,
  IconFileCode,
  IconFileCode2,
  IconFileSettings,
  IconFileUnknown,
  IconFileDatabase,
  IconFileSpreadsheet,
  IconTextScan2,
  // File-type icons (Tabler's colored filetype set). Used by the shared
  // fileIcon helper in lib/fileIcon.ts for per-extension file icons across the
  // file tree, editor tabs, and editor toolbar.
  IconFileTypeBmp,
  IconFileTypeCss,
  IconFileTypeCsv,
  IconFileTypeDoc,
  IconFileTypeDocx,
  IconFileTypeHtml,
  IconFileTypeJpg,
  IconFileTypeJs,
  IconFileTypeJsx,
  IconFileTypePdf,
  IconFileTypePhp,
  IconFileTypePng,
  IconFileTypePpt,
  IconFileTypeRs,
  IconFileTypeSql,
  IconFileTypeSvg,
  IconFileTypeTs,
  IconFileTypeTsx,
  IconFileTypeTxt,
  IconFileTypeVue,
  IconFileTypeXls,
  IconFileTypeXml,
  IconFileTypeZip,
  // Language / ecosystem brand icons for file types without a dedicated
  // IconFileType* (e.g. python, go, docker). Note: no IconBrandJava /
  // IconBrandMarkdown in this tabler version - those extensions fall back to
  // IconFile / IconFileText in the helper.
  IconBrandPython,
  IconBrandGolang,
  IconBrandKotlin,
  IconBrandCpp,
  IconBrandCSharp,
  IconBrandSwift,
  IconBrandDocker,
  IconBrandGit,
  IconBrandSass,
  IconBrandOpenai,
  IconNotebook,
  IconClipboard,
  IconClipboardText,
  IconPaperclip,
  IconFolder,
  IconFolderOpen,
  IconFolderPlus,
  IconFolderMinus,
  IconFiles,
  IconGitBranch,
  IconGitCommit,
  IconGitMerge,
  IconGitFork,
  IconArrowsSplit,
  IconFileSymlink,
  IconSparkles,
  IconAt,
  IconSlash,
  IconCommand,
  IconDatabase,
  IconCoins,
  IconArrowBarToDown,
  IconArrowBarToUp,
  IconStack2,
  IconStackFilled,
  IconCategoryFilled,
  IconChartBar,
  IconCalendarStats,
  // Editing / actions
  IconPencil,
  IconReplace,
  IconRocket,
  // Communication
  IconMessage,
  IconMessages,
  IconMail,
  IconBell,
  IconSettings,
  IconUser,
  IconUsers,
  IconHelpCircle,
  IconQuestionMark,
  // Voice input
  IconMicrophone,
  IconMicrophoneFilled,
  IconMicrophoneOff,
  IconWaveSine,
  IconCircleFilled,
  // Layout / window
  IconLayoutSidebarLeftExpand,
  IconLayoutSidebarRightExpand,
  IconColumns3,
  IconMaximize,
  IconMinimize,
  IconExternalLink,
  IconGripHorizontal,
  IconGripVertical,
  // Objects
  IconKey,
  IconKeyboard,
  IconHandMove,
  IconLink,
  IconUnlink,
  IconLock,
  IconLockOpen,
  IconClock,
  IconCalendar,
  IconHash,
  IconTag,
  IconTags,
  IconBookmark,
  IconBook,
  IconFlask,
  IconPalette,
  IconDeviceFloppy,
  IconSelector,
  IconAdjustmentsHorizontal,
  IconList,
  IconListDetails,
  IconListTree,
  IconInbox,
  IconListCheck,
  IconSquare,
  IconLanguage,
  IconGlobe,
  IconWorldWww,
  IconWorld,
  IconWorldSearch,
  // Connectivity / relay
  IconWifi,
  IconPlugConnected,
  IconServer,
  IconSun,
  IconMoon,
  // Search toggles
  IconLetterCase,
  // Status-capsule icons
  IconHexagon,
  IconRobot,
  IconRobotFace,
  IconCpu,
  // Theme picker icons
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDevices,
  // Permission / security
  IconShield,
  IconShieldCheck,
  IconShieldLock,
  IconShieldHalfFilled,
  // Cognition / AI (thinking, brainstorming)
  IconBrain,
  IconBulb,
  // Browser panel: element picker toggle
  IconTarget,
  // "None / not supported" state (e.g. "no model selected" dropdown items)
  IconCircleOff,
} from "@tabler/icons-react";

/* ───────── Shorthand aliases (commonly used) ───────── */
export { IconX as XIcon } from "@tabler/icons-react";
export { IconCheck as CheckIcon } from "@tabler/icons-react";
export { IconPlus as PlusIcon } from "@tabler/icons-react";
export { IconEdit as EditIcon } from "@tabler/icons-react";
export { IconTrash as TrashIcon } from "@tabler/icons-react";
export { IconCopy as CopyIcon } from "@tabler/icons-react";
export { IconSearch as SearchIcon } from "@tabler/icons-react";
export { IconSettings as SettingsIcon } from "@tabler/icons-react";
export { IconBolt as BoltIcon } from "@tabler/icons-react";
export { IconDots as DotsIcon } from "@tabler/icons-react";
export { IconDotsVertical as DotsVerticalIcon } from "@tabler/icons-react";
export { IconFolder as FolderIcon } from "@tabler/icons-react";
export { IconMessage as MessageIcon } from "@tabler/icons-react";
export { IconCode as CodeIcon } from "@tabler/icons-react";
export { IconTerminal2 as TerminalIcon } from "@tabler/icons-react";
export { IconGlobe as GlobeIcon } from "@tabler/icons-react";
export { IconKey as KeyIcon } from "@tabler/icons-react";
export { IconSun as SunIcon } from "@tabler/icons-react";
export { IconMoon as MoonIcon } from "@tabler/icons-react";
export { IconChevronDown as ChevronDownIcon } from "@tabler/icons-react";
export { IconChevronRight as ChevronRightIcon } from "@tabler/icons-react";
export { IconArrowRight as ArrowRightIcon } from "@tabler/icons-react";
export { IconInfoCircle as InfoIcon } from "@tabler/icons-react";
export { IconAlertTriangle as WarningIcon } from "@tabler/icons-react";
export { IconAlertCircle as AlertIcon } from "@tabler/icons-react";
export { IconLoader2 as SpinnerIcon } from "@tabler/icons-react";
export { IconMenu2 as MenuIcon } from "@tabler/icons-react";
export { IconExternalLink as ExternalLinkIcon } from "@tabler/icons-react";

/* ───────── react-icons (auxiliary sets — only when Tabler lacks an icon) ───────── */

// Phosphor icons
export { PiSquareSplitHorizontal } from "react-icons/pi";

// Remix icons
export { RiApps2Line } from "react-icons/ri";

// Phosphor icons
export { PiRobot } from "react-icons/pi";

// Phosphor icons — browser device toolbar rotate (portrait/landscape)
export { PiArrowsClockwise } from "react-icons/pi";

// Simple Icons (brands)
export { SiGithub } from "react-icons/si";
export { SiClaude } from "react-icons/si";
export { SiGoogle } from "react-icons/si";

// VS Code icons
export { VscMcp } from "react-icons/vsc";
import { VscMcp as VscMcpGlyph } from "react-icons/vsc";
import type { IconProps } from "@tabler/icons-react";

/** VscMcp adapted to the TablerIconProps shape — react-icons' IconType takes
 *  IconBaseProps, whose `stroke` is string-only and clashes with Tabler's
 *  `stroke?: string | number`, so VscMcp itself can't sit in a
 *  ComponentType<TablerIconProps> slot (settings nav, PanelHeader icon). */
export function McpIcon({ size = 24, className }: IconProps) {
  return <VscMcpGlyph size={size} className={className} />;
}

/* ───────── Custom brand marks (not in any icon library) ───────── */

/**
 * Pi (earendil-works/pi) brand mark — the official logo from pi.dev.
 *
 * react-icons / Simple Icons don't carry this brand, so we inline the SVG
 * from pi.dev's logo-auto.svg. It's a blocky "Pi" glyph: a P shape (with an
 * evenodd-cut hole) plus a detached i dot. fill="currentColor" lets the
 * caller tint it via className (e.g. text-accent), matching the <Icon size>
 * convention used everywhere else. viewBox 0 0 800 800 is the original.
 */
/** OpenAI brand mark — react-icons 5.x dropped SiOpenai (removed from
 *  simple-icons), so the glyph is inlined here (monochrome, currentColor),
 *  same pattern as PiBrandIcon. */
export function OpenAIBrandIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
    </svg>
  );
}

export function PiBrandIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 800 800"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}
