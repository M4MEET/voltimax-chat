import VoltimaxChatPlugin from './voltimax-chat/voltimax-chat.plugin';

const PluginManager = window.PluginManager;
PluginManager.register('VoltimaxChat', VoltimaxChatPlugin, '[data-voltimax-chat]');
