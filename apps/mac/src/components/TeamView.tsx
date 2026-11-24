import { useEffect, useState } from 'react';
import { Banner, BlockStack, Button, Card, InlineStack, Panel, SegmentedControl, Text, TextField } from '@crew/ui';
import { useApp, type TeamInfo, type TeamSource, type WhereInfo } from '../store';

/** The team's server. One for now, so choosing Server connects to it straight away. */
const SERVER = 'crew.paul.studio';

type Kind = TeamSource['kind'];

/** Where the team comes from: the example team, a GitHub repo Crew keeps up to date, or a folder. */
export function TeamView() {
  const teamName = useApp((s) => s.teamName);
  const roles = useApp((s) => s.roles);
  const host = window.crewHost;
  const [info, setInfo] = useState<TeamInfo | null>(null);
  const [kind, setKind] = useState<Kind>('example');
  const [repo, setRepo] = useState('');
  const [path, setPath] = useState('crew');
  const [branch, setBranch] = useState('main');
  const [dir, setDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = () =>
    host?.teamInfo?.().then((i) => {
      setInfo(i);
      setKind(i.kind);
      if (i.kind === 'github') {
        setRepo(i.repo);
        setPath(i.path);
        setBranch(i.branch);
      }
      if (i.kind === 'folder') setDir(i.dir);
    });
  useEffect(() => void load(), []);

  if (!host?.teamInfo) {
    return (
      <Page>
        <Text tone="secondary">The team is chosen in the installed Crew app. From a checkout, set CREW_TEAM_DIR in .env.local.</Text>
      </Page>
    );
  }

  const next: TeamSource =
    kind === 'github' ? { kind, repo, path, branch } : kind === 'folder' ? { kind, dir } : { kind: 'example' };

  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    const err = await host.teamSet!(next);
    setBusy(false);
    if (err) setError(err);
    else {
      setSaved(true);
      void load();
    }
  };

  return (
    <Page>
      <BlockStack gap="200">
        <Text variant="bodyMd" tone="secondary">
          Now: <strong>{teamName || 'Crew'}</strong> · {roles.length} {roles.length === 1 ? 'agent' : 'agents'} · {describe(info)}
        </Text>
        {info && !info.supported && (
          <Banner tone="info">This Crew runs on a server (or from a checkout), so the team is chosen there.</Banner>
        )}
      </BlockStack>

      <WhereCard />

      {info?.supported !== false && (
      <Card>
        <BlockStack gap="400" className="team-form">
          <SegmentedControl<Kind>
            label="Team source"
            value={kind}
            onValueChange={setKind}
            items={[
              { value: 'github', label: 'From GitHub' },
              { value: 'folder', label: 'Folder on this Mac' },
              { value: 'example', label: 'Example team' },
            ]}
          />

          {kind === 'github' && (
            <BlockStack gap="300">
              <TextField showLabel label="Repository" placeholder="owner/name" value={repo} onChange={setRepo} />
              <InlineStack gap="300">
                <TextField showLabel label="Team folder in the repo" value={path} onChange={setPath} className="grow" />
                <TextField showLabel label="Branch" value={branch} onChange={setBranch} className="grow" />
              </InlineStack>
              <Text variant="caption" tone="secondary">
                Crew keeps its own copy in ~/.crew/teams, made with your git sign-in, and shows Update team in the sidebar when the team
                folder (or the brand files it uses) changes on this branch. Your own checkouts are never touched.
              </Text>
            </BlockStack>
          )}

          {kind === 'folder' && (
            <BlockStack gap="300">
              <InlineStack gap="300" blockAlign="end">
                <TextField showLabel label="Team folder" placeholder="/Users/you/repo/crew" value={dir} onChange={setDir} className="grow" />
                <Button
                  onClick={async () => {
                    const picked = await host.teamChooseFolder?.();
                    if (picked) setDir(picked);
                  }}
                >
                  Choose…
                </Button>
              </InlineStack>
              <Text variant="caption" tone="secondary">
                Crew runs the folder as it is. You keep it up to date yourself, for example with git pull.
              </Text>
            </BlockStack>
          )}

          {kind === 'example' && (
            <Text variant="caption" tone="secondary">
              The small team that comes with Crew: a GM and a Web researcher.
            </Text>
          )}

          {error && <Banner tone="critical">{error}</Banner>}
          {saved && !error && <Banner tone="info">Team switched. The conductor restarted with it.</Banner>}

          <InlineStack gap="300">
            <Button variant="primary" onClick={() => void save()} disabled={busy || (info ? !info.supported : true) || (kind === 'github' && !repo.trim()) || (kind === 'folder' && !dir.trim())}>
              {busy ? (kind === 'github' ? 'Getting the team…' : 'Switching…') : 'Use this team'}
            </Button>
            <Text variant="caption" tone="tertiary">
              Switching restarts the conductor: agents that are working stop and can be resumed.
            </Text>
          </InlineStack>
        </BlockStack>
      </Card>
      )}
    </Page>
  );
}

/**
 * Where Crew runs: this Mac's own conductor, or the team's server. Choosing one
 * switches at once; for the server the sign-in then opens in the browser.
 */
function WhereCard() {
  const host = window.crewHost;
  const [where, setWhere] = useState<WhereInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => void host?.whereInfo?.().then(setWhere), []);
  if (!host?.whereInfo || !where) return null;

  const choose = async (mode: WhereInfo['mode']) => {
    if (mode === where.mode || busy) return;
    setBusy(true);
    setError(null);
    // On success the window reloads and connects (the server asks you to sign in first).
    const err = await host.whereSet!({ mode, url: SERVER });
    setBusy(false);
    if (err) setError(err);
  };

  return (
    <Card>
      <BlockStack gap="300" className="team-form">
        <SegmentedControl<WhereInfo['mode']>
          label="Where Crew runs"
          value={where.mode}
          onValueChange={(m) => void choose(m)}
          items={[
            { value: 'local', label: 'This Mac' },
            { value: 'server', label: 'Server' },
          ]}
        />
        <Text variant="caption" tone="secondary">
          {busy
            ? 'Switching…'
            : where.mode === 'server'
              ? `On the team's server (${(where.url ?? SERVER).replace(/^https:\/\//, '')}): the same agents, threads and Inbox for everyone. You sign in with Google in your browser.`
              : 'Here, on your own engine sign-ins. Choose the team below.'}
        </Text>
        {where.fixed && <Banner tone="info">Set outside the app (a checkout or CREW_CONDUCTOR_URL), so it can't be changed here.</Banner>}
        {error && <Banner tone="critical">{error}</Banner>}
      </BlockStack>
    </Card>
  );
}

function describe(info: TeamInfo | null): string {
  if (!info) return '…';
  if (info.kind === 'github') return `${info.repo} · ${info.path} · ${info.branch}${info.revision ? ` · ${info.revision}` : ''}`;
  if (info.kind === 'folder') return info.dir;
  return 'example team';
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <Panel as="main" className="pane-main pane-page">
      <div className="page-drag cr-drag" />
      <div className="pane-scroll">
        <BlockStack gap="700" className="page">
          <BlockStack>
            <Text variant="headingLg">Team</Text>
            <Text variant="bodyMd" tone="secondary">
              Which agents this Crew runs, and where their definition comes from.
            </Text>
          </BlockStack>
          {children}
        </BlockStack>
      </div>
    </Panel>
  );
}
