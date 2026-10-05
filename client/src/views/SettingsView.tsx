import { Settings, Status } from '../types';
import SettingsPanel from '../components/SettingsPanel';
import { Panel } from '../motion/primitives';
import { IconAlert, IconShield, IconWaves } from '../motion/Icons';

export default function SettingsView({
  settings,
  status,
  onSaved,
  onError,
  motionOn,
  onToggleMotion,
}: {
  settings: Settings | null;
  status: Status | null;
  onSaved: (s: Settings) => void;
  onError: (msg: string) => void;
  motionOn: boolean;
  onToggleMotion: () => void;
}) {
  return (
    <div className="grid-2">
      <SettingsPanel settings={settings} onSaved={onSaved} onError={onError} />

      <div className="col-stack">
        <Panel title="Execution Guardrails" icon={<IconShield />} sub="read-only" meta={status?.mode ?? '—'}>
          <div className="mini-grid">
            <div className="mini">
              <div className="k">Auto-trading</div>
              <div className={`v ${status?.autoTrade ? 'up' : 'down'}`}>{status?.autoTrade ? 'ON' : 'OFF'}</div>
            </div>
            <div className="mini">
              <div className="k">Testnet keys</div>
              <div className={`v ${status?.keysConfigured?.testnet ? 'up' : ''}`}>
                {status?.keysConfigured?.testnet ? 'configured' : 'missing'}
              </div>
            </div>
            <div className="mini">
              <div className="k">Live keys</div>
              <div className={`v ${status?.keysConfigured?.live ? 'up' : ''}`}>
                {status?.keysConfigured?.live ? 'configured' : 'missing'}
              </div>
            </div>
            <div className="mini">
              <div className="k">Balance source</div>
              <div className="v">{status?.balance?.source ?? '—'}</div>
            </div>
          </div>
          <div className="hint warn mt" style={{ display: 'flex', gap: 7 }}>
            <IconAlert style={{ width: 14, height: 14, flex: 'none', marginTop: 2 }} />
            The bot never touches manual positions — it only manages trades it opened itself. Keep leverage and size
            conservative until the paper log proves the edge.
          </div>
        </Panel>

        <Panel title="Interface Motion" icon={<IconWaves />} sub="liquid glass" meta={motionOn ? 'animated' : 'calm'}>
          <div className="kv-row">
            <span className="k">Liquid background flow</span>
            <span className="v">{motionOn ? 'Flowing' : 'Static'}</span>
          </div>
          <div className="kv-row">
            <span className="k">Section reveal + morph</span>
            <span className="v">{motionOn ? 'Enabled' : 'Disabled'}</span>
          </div>
          <div className="kv-row">
            <span className="k">Chart draw + live tail</span>
            <span className="v">{motionOn ? 'Animated' : 'Instant'}</span>
          </div>
          <div className="row mt">
            <button className="btn sm" onClick={onToggleMotion}>
              {motionOn ? 'Calm the interface' : 'Re-enable motion'}
            </button>
            <span className="hint">Stored locally — also honours your OS “reduce motion” setting.</span>
          </div>
        </Panel>
      </div>
    </div>
  );
}
