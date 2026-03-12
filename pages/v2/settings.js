import Head from 'next/head';
import { useRouter } from 'next/router';
import V2Layout from '../../components/v2/V2Layout';

export default function SettingsPage() {
  const router = useRouter();

    return (
    <V2Layout>
        <Head><title>Settings — BINUSFace v2</title></Head>

    {/* Main Content */}
    <div className="px-4 sm:px-6 lg:px-8 py-6 lg:py-8 max-w-[1600px] mx-auto">
        
        {/* Hero Section */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
            <div>
                <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-white">System Settings</h1>
                <p className="text-slate-400 mt-2 max-w-2xl">Configure AI recognition parameters, manage access, and control system integrations.</p>
            </div>
            <div className="flex items-center gap-3">
                <button onClick={() => router.push('/v2')} className="px-4 py-2.5 glass-panel rounded-lg text-sm font-medium text-slate-300 hover:text-white hover:bg-slate-800/80 transition-all border border-slate-700">
                    Discard Changes
                </button>
                <button className="flex items-center gap-2 px-6 py-2.5 bg-brand-500 hover:bg-brand-400 text-slate-950 rounded-lg text-sm font-semibold transition-all shadow-[0_0_20px_rgba(6,182,212,0.3)] hover:shadow-[0_0_25px_rgba(6,182,212,0.5)] active:scale-95">
                    <i className="ph ph-check-circle text-lg"></i>
                    Save Settings
                </button>
            </div>
        </div>

        {/* Layout Grid for Settings */}
        <div className="flex flex-col lg:flex-row gap-8">
            
            {/* Left Sidebar Navigation */}
            <aside className="w-full lg:w-64 flex-shrink-0">
                <nav className="space-y-1">
                    <a href="#ai-parameters" className="flex items-center gap-3 px-4 py-3 rounded-xl bg-white/5 text-brand-400 border border-slate-700/50 transition-colors">
                        <i className="ph ph-bounding-box text-xl"></i>
                        <span className="font-medium text-sm">AI Parameters</span>
                    </a>
                    <a href="#user-management" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors">
                        <i className="ph ph-users text-xl"></i>
                        <span className="font-medium text-sm">User Management</span>
                    </a>
                    <a href="#notifications" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors">
                        <i className="ph ph-bell-ringing text-xl"></i>
                        <span className="font-medium text-sm">Notifications</span>
                    </a>
                    <a href="#integrations" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors">
                        <i className="ph ph-plugs text-xl"></i>
                        <span className="font-medium text-sm">Integrations</span>
                    </a>
                    <a href="#security" className="flex items-center gap-3 px-4 py-3 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-white/5 transition-colors">
                        <i className="ph ph-shield-check text-xl"></i>
                        <span className="font-medium text-sm">Security &amp; Audit</span>
                    </a>
                </nav>
            </aside>

            {/* Right Content Area */}
            <div className="flex-1 space-y-8 pb-12">
                
                {/* Section: AI Parameters */}
                <div id="ai-parameters" className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40">
                        <h2 className="text-lg font-semibold text-white">Facial Recognition Engine</h2>
                        <p className="text-sm text-slate-400 mt-1">Adjust sensitivity, confidence thresholds, and processing modes.</p>
                    </div>
                    
                    <div className="p-6 space-y-8">
                        {/* Confidence Threshold Setting */}
                        <div className="max-w-3xl">
                            <div className="flex items-center justify-between mb-2">
                                <div>
                                    <label className="text-sm font-medium text-white block">Match Confidence Threshold</label>
                                    <p className="text-xs text-slate-400 mt-1">Minimum AI confidence score required to automatically mark a student as present. Lower scores will trigger manual review alerts.</p>
                                </div>
                                <div className="px-3 py-1 bg-brand-500/10 border border-brand-500/20 text-brand-400 rounded-lg font-mono text-sm">
                                    90%
                                </div>
                            </div>
                            <div className="relative pt-4">
                                <input type="range" min="50" max="100" defaultValue="90" className="w-full z-20 relative" />
                                <div className="flex justify-between text-[10px] text-slate-500 mt-2 font-mono">
                                    <span>50% (Lenient)</span>
                                    <span>75%</span>
                                    <span>100% (Strict)</span>
                                </div>
                            </div>
                        </div>

                        <hr className="border-slate-800" />

                        {/* Toggles Settings */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-4xl">
                            
                            {/* Toggle 1 */}
                            <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-slate-800 bg-slate-900/30 hover:bg-slate-800/50 transition-colors">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <i className="ph ph-face-mask text-amber-400"></i>
                                        <label className="text-sm font-medium text-white block">Liveness Detection</label>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">Active anti-spoofing mechanism to prevent bypass using 2D photos or digital screens.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0 mt-1">
                                    <input type="checkbox" className="sr-only peer" defaultChecked />
                                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-500 shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]"></div>
                                </label>
                            </div>

                            {/* Toggle 2 */}
                            <div className="flex items-start justify-between gap-4 p-4 rounded-xl border border-slate-800 bg-slate-900/30 hover:bg-slate-800/50 transition-colors">
                                <div className="flex-1">
                                    <div className="flex items-center gap-2">
                                        <i className="ph ph-users-three text-indigo-400"></i>
                                        <label className="text-sm font-medium text-white block">Crowd Processing</label>
                                    </div>
                                    <p className="text-xs text-slate-400 mt-1 leading-relaxed">Enable multi-face tracking in busy corridors. May increase latency slightly.</p>
                                </div>
                                <label className="relative inline-flex items-center cursor-pointer flex-shrink-0 mt-1">
                                    <input type="checkbox" className="sr-only peer" defaultChecked />
                                    <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-500 shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]"></div>
                                </label>
                            </div>
                        </div>

                        {/* Dropdowns */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 max-w-4xl">
                            <div>
                                <label className="text-sm font-medium text-white block mb-2">Processing Node Allocation</label>
                                <div className="relative">
                                    <select className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 pl-4 pr-10 text-sm text-white appearance-none focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all cursor-pointer">
                                        <option value="hybrid">Hybrid (Edge + Cloud fallback)</option>
                                        <option value="edge">Edge Only (Lowest Latency)</option>
                                        <option value="cloud">Cloud Only (High Accuracy)</option>
                                    </select>
                                    <i className="ph ph-caret-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"></i>
                                </div>
                            </div>
                            <div>
                                <label className="text-sm font-medium text-white block mb-2">Data Retention Period</label>
                                <div className="relative">
                                    <select className="w-full bg-slate-950/50 border border-slate-700 rounded-lg py-2.5 pl-4 pr-10 text-sm text-white appearance-none focus:outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 transition-all cursor-pointer">
                                        <option value="30">30 Days (Compliance standard)</option>
                                        <option value="90">90 Days</option>
                                        <option value="365">1 Year</option>
                                    </select>
                                    <i className="ph ph-caret-down absolute right-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"></i>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Section: User Management */}
                <div id="user-management" className="glass-panel rounded-2xl border border-slate-800 overflow-hidden shadow-lg shadow-black/20">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                            <h2 className="text-lg font-semibold text-white">Access Management</h2>
                            <p className="text-sm text-slate-400 mt-1">Manage administrators, security staff, and system viewers.</p>
                        </div>
                        <button className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-all border border-slate-700">
                            <i className="ph ph-user-plus text-lg text-brand-400"></i>
                            Invite User
                        </button>
                    </div>

                    <div className="overflow-x-auto">
                        <table className="w-full text-left whitespace-nowrap text-sm border-collapse">
                            <thead className="bg-slate-950/50 text-slate-400 border-b border-slate-800 text-xs uppercase tracking-wider font-semibold">
                                <tr>
                                    <th className="px-6 py-4">User</th>
                                    <th className="px-6 py-4">Role &amp; Access Level</th>
                                    <th className="px-6 py-4">Status</th>
                                    <th className="px-6 py-4">Last Active</th>
                                    <th className="px-6 py-4 w-12"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800/50">
                                
                                {/* Admin 1 */}
                                <tr className="hover:bg-slate-800/30 transition-colors group">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-brand-500/20 text-brand-400 flex items-center justify-center font-bold border border-brand-500/30">
                                                AD
                                            </div>
                                            <div>
                                                <div className="font-medium text-white">Alex Doe (You)</div>
                                                <div className="text-xs text-slate-500 mt-0.5">alex.doe@university.edu</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="text-slate-300 font-medium">Super Admin</div>
                                        <div className="text-xs text-slate-500 mt-0.5">Full System Access</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                            Active
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-slate-400">Right now</td>
                                    <td className="px-6 py-4 text-right text-slate-500"></td>
                                </tr>

                                {/* Security Staff */}
                                <tr className="hover:bg-slate-800/30 transition-colors group">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <img alt="" src="https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=100&h=100&fit=crop&q=80" className="w-8 h-8 rounded-full border border-slate-700" />
                                            <div>
                                                <div className="font-medium text-white">Robert Chen</div>
                                                <div className="text-xs text-slate-500 mt-0.5">r.chen@university.edu</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="text-slate-300 font-medium">Security Officer</div>
                                        <div className="text-xs text-slate-500 mt-0.5">Dashboard, Alerts Review</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                                            Active
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-slate-400">2 hours ago</td>
                                    <td className="px-6 py-4 text-right text-slate-500 group-hover:text-white transition-colors cursor-pointer">
                                        <button className="text-sm font-medium hover:underline decoration-slate-500 underline-offset-2">Edit</button>
                                    </td>
                                </tr>

                                {/* Academic Staff */}
                                <tr className="hover:bg-slate-800/30 transition-colors group">
                                    <td className="px-6 py-4">
                                        <div className="flex items-center gap-3">
                                            <div className="w-8 h-8 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center font-bold border border-slate-700">
                                                SJ
                                            </div>
                                            <div>
                                                <div className="font-medium text-white">Dr. Sarah Jenkins</div>
                                                <div className="text-xs text-slate-500 mt-0.5">s.jenkins@university.edu</div>
                                            </div>
                                        </div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <div className="text-slate-300 font-medium">Dept. Head Viewer</div>
                                        <div className="text-xs text-slate-500 mt-0.5">Analytics Only (Science)</div>
                                    </td>
                                    <td className="px-6 py-4">
                                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] uppercase font-bold bg-amber-500/10 text-amber-400 border border-amber-500/20">
                                            Pending
                                        </span>
                                    </td>
                                    <td className="px-6 py-4 text-slate-400">Never</td>
                                    <td className="px-6 py-4 text-right text-slate-500 group-hover:text-white transition-colors cursor-pointer">
                                        <button className="text-sm font-medium hover:underline decoration-slate-500 underline-offset-2">Resend</button>
                                    </td>
                                </tr>

                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Section: Notifications */}
                <div id="notifications" className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40">
                        <h2 className="text-lg font-semibold text-white">System Notifications</h2>
                        <p className="text-sm text-slate-400 mt-1">Configure when and how alerts are dispatched.</p>
                    </div>
                    
                    <div className="p-0">
                        <ul className="divide-y divide-slate-800/50">
                            
                            {/* Setting Item */}
                            <li className="p-6 flex items-start sm:items-center justify-between gap-4 hover:bg-slate-900/20 transition-colors">
                                <div>
                                    <p className="text-sm font-medium text-white">Manual Verification Required</p>
                                    <p className="text-xs text-slate-400 mt-1">Notify security staff when a scan falls below the confidence threshold or is misaligned.</p>
                                </div>
                                <div className="flex items-center gap-3 flex-shrink-0">
                                    <div className="flex items-center gap-2 border border-slate-700 bg-slate-950 rounded-lg p-1">
                                        <button className="px-3 py-1 text-xs font-medium rounded bg-slate-800 text-white">Email</button>
                                        <button className="px-3 py-1 text-xs font-medium rounded text-slate-400 hover:text-white">Push</button>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" className="sr-only peer" defaultChecked />
                                        <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-brand-500 shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]"></div>
                                    </label>
                                </div>
                            </li>

                            {/* Setting Item */}
                            <li className="p-6 flex items-start sm:items-center justify-between gap-4 hover:bg-slate-900/20 transition-colors">
                                <div>
                                    <p className="text-sm font-medium text-white">Hardware / Node Failure</p>
                                    <p className="text-xs text-slate-400 mt-1">Immediate alerts if a camera goes offline or edge processor loses connection.</p>
                                </div>
                                <div className="flex items-center gap-3 flex-shrink-0">
                                    <div className="flex items-center gap-2 border border-slate-700 bg-slate-950 rounded-lg p-1">
                                        <button className="px-3 py-1 text-xs font-medium rounded bg-slate-800 text-white">Email</button>
                                        <button className="px-3 py-1 text-xs font-medium rounded text-slate-400 hover:text-white">SMS</button>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" className="sr-only peer" defaultChecked />
                                        <div className="w-11 h-6 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-red-500 shadow-[inset_0_2px_4px_rgba(0,0,0,0.2)]"></div>
                                    </label>
                                </div>
                            </li>

                            {/* Setting Item */}
                            <li className="p-6 flex items-start sm:items-center justify-between gap-4 hover:bg-slate-900/20 transition-colors opacity-60">
                                <div>
                                    <p className="text-sm font-medium text-white">Daily Attendance Summary</p>
                                    <p className="text-xs text-slate-400 mt-1">Receive an automated PDF report summarizing campus-wide attendance stats.</p>
                                </div>
                                <div className="flex items-center gap-3 flex-shrink-0">
                                    <div className="flex items-center gap-2 border border-slate-800 bg-slate-950 rounded-lg p-1">
                                        <button className="px-3 py-1 text-xs font-medium rounded bg-slate-800 text-white">Email</button>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-not-allowed">
                                        <input type="checkbox" className="sr-only peer" disabled />
                                        <div className="w-11 h-6 bg-slate-800 rounded-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-slate-600 after:border-slate-500 after:border after:rounded-full after:h-5 after:w-5"></div>
                                    </label>
                                </div>
                            </li>

                        </ul>
                    </div>
                </div>

                {/* Section: Integrations */}
                <div id="integrations" className="glass-panel rounded-2xl border border-slate-800 overflow-hidden">
                    <div className="px-6 py-5 border-b border-slate-800 bg-slate-900/40">
                        <div className="flex items-center gap-2">
                            <h2 className="text-lg font-semibold text-white">External Integrations</h2>
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 uppercase tracking-wide">Beta</span>
                        </div>
                        <p className="text-sm text-slate-400 mt-1">Connect AuraSense data directly to your institution&apos;s tech stack.</p>
                    </div>
                    
                    <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                        
                        {/* Integration Card */}
                        <div className="border border-slate-700 rounded-xl p-5 bg-slate-900/50 flex flex-col justify-between group hover:border-brand-500/50 transition-colors">
                            <div>
                                <div className="w-10 h-10 rounded bg-slate-800 border border-slate-700 flex items-center justify-center mb-4">
                                    <i className="ph ph-database text-xl text-slate-300"></i>
                                </div>
                                <h3 className="text-white font-medium mb-1">Student Information System</h3>
                                <p className="text-xs text-slate-400">Sync rosters and write attendance records back to Canvas or Blackboard via API.</p>
                            </div>
                            <div className="mt-6 flex items-center justify-between">
                                <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500"></div> Connected
                                </span>
                                <button className="text-xs font-medium text-slate-300 hover:text-white border border-slate-700 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 transition-colors">Manage Sync</button>
                            </div>
                        </div>

                        {/* Integration Card */}
                        <div className="border border-slate-800 rounded-xl p-5 bg-slate-950/30 flex flex-col justify-between group hover:border-slate-600 transition-colors">
                            <div>
                                <div className="w-10 h-10 rounded bg-[#E5E7EB] border border-slate-700 flex items-center justify-center mb-4">
                                    <svg className="w-6 h-6 text-[#E01E5A]" viewBox="0 0 24 24" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1 2.521-2.52A2.528 2.528 0 0 1 13.877 5.042a2.527 2.527 0 0 1-2.521 2.52h-2.52v-2.52zM8.834 6.313a2.527 2.527 0 0 1 2.521 2.521 2.527 2.527 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.527 2.527 0 0 1-2.522 2.52h-2.522v-2.52zM17.688 8.834a2.527 2.527 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.528 2.528 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1-2.523 2.522A2.528 2.528 0 0 1 10.12 18.956a2.527 2.527 0 0 1 2.523-2.52h2.522v2.52zM15.165 17.688a2.527 2.527 0 0 1-2.523-2.523 2.526 2.526 0 0 1 2.523-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></svg>
                                </div>
                                <h3 className="text-white font-medium mb-1">Slack Alerts</h3>
                                <p className="text-xs text-slate-400">Route critical security and anomaly notifications to designated Slack channels.</p>
                            </div>
                            <div className="mt-6 flex items-center justify-between">
                                <span className="text-xs text-slate-500">Not configured</span>
                                <button className="text-xs font-medium text-slate-300 hover:text-white border border-slate-700 px-3 py-1.5 rounded bg-slate-900 hover:bg-slate-800 transition-colors">Configure</button>
                            </div>
                        </div>

                    </div>
                </div>

            </div>
        </div>

    </div>

    {/* Footer */}
    <footer className="border-t border-slate-800/50 bg-slate-950/80 backdrop-blur-sm mt-8 py-6">
        <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm">
                <i className="ph ph-shield-check text-brand-500 text-lg"></i>
                <span>BINUSFace Attendance System v2</span>
            </div>
            <div className="flex items-center gap-6 text-sm">
                <span className="text-slate-600">BINUS School Serpong</span>
            </div>
        </div>
    </footer>
    </V2Layout>
    );
}
