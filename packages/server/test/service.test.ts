import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from 'cordis';
import { AgentPeripheralStatus } from '@dsh-hid/protocol';
import { PeripheralServerService } from '../src/service.js';

describe('PeripheralServerService (Cordis integration)', () => {
  let ctx: Context;
  let service: PeripheralServerService;

  beforeEach(() => {
    ctx = new Context();
    service = new PeripheralServerService(ctx, {
      port: 0,
      autoBindSlots: true,
    });
  });

  afterEach(async () => {
    await service.stop();
  });

  it('injects into cordis context correctly', () => {
    expect(service).toBeDefined();
    expect(service.router).toBeDefined();
    expect(service.wsServer).toBeDefined();
  });

  it('handles agent/created and automatically allocates slots', () => {
    ctx.emit('agent/created', 'session-alpha');

    const slot = service.router.getSlotBySessionId('session-alpha');
    expect(slot).not.toBeNull();
    expect(slot?.slotIndex).toBe(1);
    expect(slot?.status).toBe(AgentPeripheralStatus.IDLE);
  });

  it('handles agent/status transitions', () => {
    ctx.emit('agent/created', 'session-status');

    ctx.emit('agent/status', 'session-status', 'running');
    let slot = service.router.getSlotBySessionId('session-status');
    expect(slot?.status).toBe(AgentPeripheralStatus.RUNNING);

    ctx.emit('agent/status', 'session-status', 'completed');
    slot = service.router.getSlotBySessionId('session-status');
    expect(slot?.status).toBe(AgentPeripheralStatus.COMPLETED);
  });

  it('handles interaction/user-questions and updates slot to NEEDS_INPUT', () => {
    ctx.emit('agent/created', 'session-hitl');
    ctx.emit('interaction/user-questions', 'session-hitl', {
      prompt: 'Allow deleting directory?',
      options: ['Allow', 'Deny'],
    });

    const slot = service.router.getSlotBySessionId('session-hitl');
    expect(slot?.status).toBe(AgentPeripheralStatus.NEEDS_INPUT);
    expect(slot?.question?.prompt).toBe('Allow deleting directory?');
    expect(slot?.question?.options).toEqual(['Allow', 'Deny']);
  });

  it('handles agent/tool-start and agent/tool-end events', () => {
    ctx.emit('agent/created', 'session-tool');
    ctx.emit('agent/tool-start', 'session-tool', 'execute_bash');

    let slot = service.router.getSlotBySessionId('session-tool');
    expect(slot?.status).toBe(AgentPeripheralStatus.RUNNING);
    expect(slot?.activeTool).toBe('execute_bash');

    ctx.emit('agent/tool-end', 'session-tool');
    slot = service.router.getSlotBySessionId('session-tool');
    expect(slot?.activeTool).toBeUndefined();
  });

  it('releases slot on agent/disposed', () => {
    ctx.emit('agent/created', 'session-temp');
    expect(service.router.getSlotBySessionId('session-temp')).not.toBeNull();

    ctx.emit('agent/disposed', 'session-temp');
    expect(service.router.getSlotBySessionId('session-temp')).toBeNull();
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.INACTIVE);
  });

  it('resets COMPLETED status to IDLE when switching focus to a slot', async () => {
    ctx.emit('agent/created', 'session-done');
    service.router.updateSlot(1, { status: AgentPeripheralStatus.COMPLETED });
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.COMPLETED);

    // Call onSwitchFocus via wsServer handler
    const handler = (service.wsServer as any).handler;
    await handler.onSwitchFocus(1);

    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.IDLE);
    expect(service.router.getFocusedSlot()).toBe(1);

    // Further api-session/status(false) must not revert IDLE back to COMPLETED
    ctx.emit('api-session/status', 'session-done', false);
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.IDLE);
  });

  it('resets COMPLETED status to IDLE when session is opened from UI', async () => {
    ctx.emit('agent/created', 'session-ui-open');
    service.router.updateSlot(1, { status: AgentPeripheralStatus.COMPLETED });
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.COMPLETED);

    const handler = (service.wsServer as any).handler;
    await handler.onSessionOpened('session-ui-open');

    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.IDLE);
  });

  it('tracks transportState, includes it in initial snapshot, and emits peripheral/transport-changed', async () => {
    const events: any[] = [];
    ctx.on('peripheral/transport-changed', (params) => {
      events.push(params);
    });

    const handler = (service.wsServer as any).handler;
    expect(service.getTransportState().transport).toBe('disconnected');

    const btState = {
      transport: 'bluetooth' as const,
      model: 'NuPhy Air75 V3',
      capabilities: {
        rgb: false,
        keys: true,
        ledBlink: true,
        wireless: true,
      },
    };

    await handler.onTransportChanged(btState);
    expect(service.getTransportState()).toEqual(btState);
    expect(handler.getInitialSnapshot().transportState).toEqual(btState);
    expect(events).toEqual([btState]);
  });

  it('binds and unbinds slot via handler and broadcasts updates', async () => {
    const handler = (service.wsServer as any).handler;
    const broadcastSpy = vi.spyOn(service.wsServer, 'broadcastSlotUpdated');

    const bindResult = await handler.onBindSlot(4, 'pinned-sess-1', 'Fixing login bug', true);
    expect(bindResult.success).toBe(true);
    expect(bindResult.slot.slotIndex).toBe(4);
    expect(bindResult.slot.sessionId).toBe('pinned-sess-1');
    expect(bindResult.slot.sessionTitle).toBe('Fixing login bug');
    expect(bindResult.slot.pinned).toBe(true);
    expect(broadcastSpy).toHaveBeenCalled();

    const unbindResult = await handler.onUnbindSlot(4);
    expect(unbindResult.success).toBe(true);
    expect(service.router.getSlot(4)?.sessionId).toBeNull();
    expect(service.router.getSlot(4)?.pinned).toBe(false);
  });

  it('discovers projects and sessions dynamically via getAvailableProjects', async () => {
    // 1. Mock context workspace and sessions services
    ctx.get = (name: string) => {
      if (name === 'workspaces') {
        return {
          list: {
            getSnapshot: () => ({
              items: [
                {
                  workspaceId: 'ws-demo',
                  title: 'Demo Project',
                  sessionIds: ['demo-sess-proj', 'demo-sess-1', 'demo-sess-2'],
                },
              ],
            }),
          },
        };
      }
      if (name === 'sessions') {
        return {
          list: () => [
            { id: 'demo-sess-proj', title: 'Demo Project' }, // should be excluded
            { id: 'demo-sess-1', title: 'Task 1' },
            { id: 'demo-sess-2', title: 'Task 2' },
          ],
        };
      }
      return undefined;
    };

    const projects = service.getAvailableProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toBe('Demo Project');
    expect(projects[0].sessions).toHaveLength(2);
    expect(projects[0].sessions[0].title).toBe('Task 1');

    const handler = (service.wsServer as any).handler;
    const rpcRes = await handler.onGetProjects();
    expect(rpcRes.success).toBe(true);
    expect(rpcRes.projects).toEqual(projects);
  });

  it('stops server cleanly when context is disposed', async () => {
    const stopSpy = vi.spyOn(service, 'stop');
    await ctx.emit('dispose');
    expect(stopSpy).toHaveBeenCalled();
  });
});
