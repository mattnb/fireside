import { describe, expect, it } from 'vitest';

import { AGENT_PERSONAS, getAgentPersona } from '../../src/agents/personas.js';

describe('agent personas', () => {
  it('keeps persona ids unique', () => {
    const ids = AGENT_PERSONAS.map((persona) => persona.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes a pragmatic principal software engineer persona', () => {
    const persona = getAgentPersona('principal-software-engineer');

    expect(persona).toMatchObject({
      id: 'principal-software-engineer',
      name: 'Principal Software Engineer',
      category: 'implementer',
    });
    expect(persona.prompt).toContain('20+ years');
    expect(persona.prompt).toContain('juice is worth the squeeze');
    expect(persona.prompt).toContain('project environment');
  });

  it('includes an adaptive quality assurance engineer persona', () => {
    const persona = getAgentPersona('quality-assurance-engineer');

    expect(persona).toMatchObject({
      id: 'quality-assurance-engineer',
      name: 'Quality Assurance Engineer',
      category: 'reviewer',
    });
    expect(persona.prompt).toContain('web apps');
    expect(persona.prompt).toContain('Windows/native desktop apps');
    expect(persona.prompt).toContain('risk-based testing');
  });

  it('includes agile planning and orchestration roles', () => {
    const projectManager = getAgentPersona('project-manager');
    const productManager = getAgentPersona('product-manager');
    const engineeringManager = getAgentPersona('engineering-manager');
    const qaLead = getAgentPersona('qa-lead');
    const technicalLead = getAgentPersona('technical-lead');

    expect(projectManager).toMatchObject({
      id: 'project-manager',
      name: 'Project Manager',
      category: 'orchestrator',
    });
    expect(projectManager.prompt).toContain('probing questions');
    expect(projectManager.prompt).toContain('first-pass phase gates');
    expect(projectManager.prompt).toContain('cross-check the phased plan');

    expect(productManager).toMatchObject({
      id: 'product-manager',
      name: 'Product Manager',
      category: 'orchestrator',
    });
    expect(productManager.prompt).toContain('user problem');
    expect(productManager.prompt).toContain('acceptance criteria');

    expect(engineeringManager).toMatchObject({
      id: 'engineering-manager',
      name: 'Engineering Manager',
      category: 'orchestrator',
    });
    expect(engineeringManager.prompt).toContain('orchestration, not hands-on implementation');
    expect(engineeringManager.prompt).toContain('tasks can run in parallel');
    expect(engineeringManager.prompt).toContain('provider strengths');

    expect(qaLead).toMatchObject({
      id: 'qa-lead',
      name: 'QA Lead',
      category: 'orchestrator',
    });
    expect(qaLead.prompt).toContain('verification orchestration');
    expect(qaLead.prompt).toContain('review and testing lanes');
    expect(qaLead.prompt).toContain('blocking or reopening phase gates');

    expect(technicalLead).toMatchObject({
      id: 'technical-lead',
      name: 'Technical Lead',
      category: 'implementer',
    });
    expect(technicalLead.prompt).toContain('implementation strategy');
    expect(technicalLead.prompt).toContain('parallelized safely');
  });

  it('includes a dedicated UX team for research, architecture, interaction, and visual systems', () => {
    const uxArchitect = getAgentPersona('ux-architect');
    const uxResearcher = getAgentPersona('ux-researcher');
    const interactionDesigner = getAgentPersona('interaction-designer');
    const visualDesigner = getAgentPersona('visual-design-systems-designer');

    expect(uxArchitect).toMatchObject({
      id: 'ux-architect',
      name: 'UX Architect',
      category: 'orchestrator',
    });
    expect(uxArchitect.prompt).toContain('design language');
    expect(uxArchitect.prompt).toContain('information architecture');
    expect(uxArchitect.prompt).toContain('generic model-default UI patterns');

    expect(uxResearcher).toMatchObject({
      id: 'ux-researcher',
      name: 'UX Researcher',
      category: 'researcher',
    });
    expect(uxResearcher.prompt).toContain('jobs to be done');
    expect(uxResearcher.prompt).toContain('Separate evidence from assumptions');
    expect(uxResearcher.prompt).toContain('usability');

    expect(interactionDesigner).toMatchObject({
      id: 'interaction-designer',
      name: 'Interaction Designer',
      category: 'designer',
    });
    expect(interactionDesigner.prompt).toContain('progressive disclosure');
    expect(interactionDesigner.prompt).toContain('focus order');
    expect(interactionDesigner.prompt).toContain('what is happening');

    expect(visualDesigner).toMatchObject({
      id: 'visual-design-systems-designer',
      name: 'Visual Design Systems Designer',
      category: 'designer',
    });
    expect(visualDesigner.prompt).toContain('typography');
    expect(visualDesigner.prompt).toContain('wow');
    expect(visualDesigner.prompt).toContain('reusable tokens');
  });
});
