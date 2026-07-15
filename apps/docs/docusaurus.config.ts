import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';

const org = 'forgewisp';
const project = 'forgewisp-core';

const config: Config = {
  title: 'Forgewisp',
  tagline: 'Safe, function-calling AI agents for the browser',
  favicon: 'img/favicon.svg',

  // Force the dark theme: a returning visitor who previously toggled to light
  // has `theme: light` in localStorage; this pins it (and the <html> attribute)
  // to dark before Docusaurus's own theme-init script reads it.
  headTags: [
    {
      tagName: 'script',
      attributes: { type: 'text/javascript' },
      innerHTML: `(function(){try{localStorage.setItem('theme','dark');document.documentElement.setAttribute('data-theme','dark');}catch(e){}})();`,
    },
  ],

  // GitHub Pages project page → https://forgewisp.github.io/forgewisp-core/
  url: `https://${org}.github.io`,
  baseUrl: `/${project}/`,

  // Trailing slash off keeps internal links stable regardless of host config.
  trailingSlash: false,

  organizationName: org,
  projectName: project,

  onBrokenLinks: 'throw',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: 'docs',
          sidebarPath: './sidebars.ts',
          editUrl: `https://github.com/${org}/${project}/edit/main/apps/docs/`,
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      },
    ],
  ],

  themeConfig: {
    image: 'img/social-card.svg',
    colorMode: {
      defaultMode: 'dark',
      disableSwitch: true,
      respectPrefersColorScheme: false,
    },
    navbar: {
      title: 'Forgewisp',
      logo: {
        alt: 'Forgewisp logo',
        src: 'img/logo.svg',
        srcDark: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: `https://github.com/${org}/${project}`,
          label: 'GitHub',
          position: 'right',
        },
        {
          href: 'https://www.npmjs.com/package/@forgewisp/core',
          label: 'npm',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Introduction', to: '/docs/intro' },
            { label: '@forgewisp/core', to: '/docs/core' },
            { label: '@forgewisp/bundled-tools', to: '/docs/bundled-tools' },
            { label: '@forgewisp/mcp', to: '/docs/mcp' },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub Issues',
              href: `https://github.com/${org}/${project}/issues`,
            },
            { label: 'Sponsor', href: `https://github.com/sponsors/${org}` },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'npm',
              href: 'https://www.npmjs.com/package/@forgewisp/core',
            },
            { label: 'GitHub', href: `https://github.com/${org}/${project}` },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Angelo Cavallo. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['json', 'bash', 'typescript', 'jsx', 'tsx'],
    },
  },
};

export default config;
