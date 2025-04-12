// public/extensions/third-party/favorites-plugin/index_new.js

// Import from the core script
import {
    eventSource,
    event_types,
    messageFormatting,
    chat,                     // 用于访问聊天记录 (优化方案需要)
    clearChat,                // 用于清空聊天
    doNewChat,                // 用于创建新聊天
    openCharacterChat,        // 用于打开角色聊天
    renameChat,               // 用于重命名聊天 (优化方案需要)
    // addOneMessage,         // 不直接导入, 使用 context.addOneMessage
} from '../../../../script.js';

// Import from the extension helper script
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings,
    saveMetadataDebounced
} from '../../../extensions.js';

// Import from the Popup utility script
import {
    Popup,
    POPUP_TYPE,
    callGenericPopup,
    POPUP_RESULT,
} from '../../../popup.js';

// Import for group chats
import { openGroupChat } from "../../../group-chats.js";

// Import from the general utility script
import {
    uuidv4,
    timestampToMoment,
    waitUntilCondition, // *** 关键：为优化方案添加导入 ***
} from '../../../utils.js';

// Define plugin folder name (important for consistency)
const pluginName = 'star6';

// Initialize plugin settings if they don't exist
if (!extension_settings[pluginName]) {
    extension_settings[pluginName] = {};
}

// Define HTML for the favorite toggle icon
const messageButtonHtml = `
    <div class="mes_button favorite-toggle-icon" title="收藏/取消收藏">
        <i class="fa-regular fa-star"></i>
    </div>
`;

// Store reference to the favorites popup
let favoritesPopup = null;
// Current pagination state
let currentPage = 1;
const itemsPerPage = 5;

/**
 * Ensures the favorites array exists in the current chat metadata accessed via getContext()
 * @returns {object | null} The chat metadata object if available and favorites array is ensured, null otherwise.
 */
function ensureFavoritesArrayExists() {
    let context;
    try {
        context = getContext();
        // 检查 context 和 context.chatMetadata 是否有效
        if (!context || !context.chatMetadata) {
            console.error(`${pluginName}: ensureFavoritesArrayExists - context or context.chatMetadata is not available!`);
            return null; // 返回 null 表示失败
        }
    } catch (e) {
        console.error(`${pluginName}: ensureFavoritesArrayExists - Error calling getContext():`, e);
        return null; // 返回 null 表示失败
    }

    // 使用 context 返回的元数据对象
    const chatMetadata = context.chatMetadata;

    // 检查 favorites 属性是否为数组，如果不是或不存在，则初始化为空数组
    if (!Array.isArray(chatMetadata.favorites)) {
        console.log(`${pluginName}: Initializing chatMetadata.favorites array.`);
        chatMetadata.favorites = [];
        // 注意：初始化后，chatMetadata 对象本身被修改了，后续保存时会保存这个修改
    }
    return chatMetadata; // 返回有效的元数据对象
}


/**
 * Adds a favorite item to the current chat metadata
 * @param {Object} messageInfo Information about the message being favorited
 */
function addFavorite(messageInfo) {
    console.log(`${pluginName}: addFavorite 函数开始执行，接收到的 messageInfo:`, messageInfo);

    const chatMetadata = ensureFavoritesArrayExists(); // 获取元数据对象
    if (!chatMetadata) { // 检查是否获取成功
         console.error(`${pluginName}: addFavorite - 获取 chatMetadata 失败，退出`);
         return;
    }

    // 创建收藏项 (已移除 timestamp)
    const item = {
        id: uuidv4(),
        messageId: messageInfo.messageId, // messageId 存储的是 mesid 字符串 (原始索引)
        sender: messageInfo.sender,
        role: messageInfo.role,
        note: ''
    };

    // 确保 favorites 是数组 (理论上 ensureFavoritesArrayExists 已保证，但多一层防护)
    if (!Array.isArray(chatMetadata.favorites)) {
        console.error(`${pluginName}: addFavorite - chatMetadata.favorites 不是数组，无法添加！`);
        return;
    }

    console.log(`${pluginName}: 添加前 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));
    chatMetadata.favorites.push(item); // 修改获取到的元数据对象的 favorites 数组
    console.log(`${pluginName}: 添加后 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));

    console.log(`${pluginName}: 即将调用 (导入的) saveMetadataDebounced 来保存更改...`);
    saveMetadataDebounced(); // 调用导入的保存函数

    console.log(`${pluginName}: Added favorite:`, item);

    // 修改这里：使用正确的方法检查弹窗是否可见
    if (favoritesPopup && favoritesPopup.dlg && favoritesPopup.dlg.hasAttribute('open')) {
        updateFavoritesPopup();
    }
}

/**
 * Removes a favorite by its ID
 * @param {string} favoriteId The ID of the favorite to remove
 * @returns {boolean} True if successful, false otherwise
 */
function removeFavoriteById(favoriteId) {
    console.log(`${pluginName}: removeFavoriteById - 尝试删除 ID: ${favoriteId}`);
    const chatMetadata = ensureFavoritesArrayExists();
    // 检查 chatMetadata 和 favorites 数组是否有效且不为空
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
        console.warn(`${pluginName}: removeFavoriteById - chatMetadata 无效或 favorites 数组为空`);
        return false;
    }

    const indexToRemove = chatMetadata.favorites.findIndex(fav => fav.id === favoriteId);
    if (indexToRemove !== -1) {
        console.log(`${pluginName}: 删除前 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));
        chatMetadata.favorites.splice(indexToRemove, 1);
        console.log(`${pluginName}: 删除后 chatMetadata.favorites:`, JSON.stringify(chatMetadata.favorites));

        console.log(`${pluginName}: 即将调用 (导入的) saveMetadataDebounced 来保存删除...`);
        saveMetadataDebounced(); // 调用导入的保存函数
        console.log(`${pluginName}: Favorite removed: ${favoriteId}`);
        return true;
    }

    console.warn(`${pluginName}: Favorite with id ${favoriteId} not found.`);
    return false;
}

/**
 * Removes a favorite by the message ID it references
 * @param {string} messageId The message ID (from mesid attribute)
 * @returns {boolean} True if successful, false otherwise
 */
function removeFavoriteByMessageId(messageId) {
    console.log(`${pluginName}: removeFavoriteByMessageId - 尝试删除 messageId: ${messageId}`);
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
         console.warn(`${pluginName}: removeFavoriteByMessageId - chatMetadata 无效或 favorites 数组为空`);
         return false;
    }

    // 根据 messageId (mesid 字符串) 查找收藏项
    const favItem = chatMetadata.favorites.find(fav => fav.messageId === messageId);
    if (favItem) {
        // 如果找到，调用按 favoriteId 删除的函数
        return removeFavoriteById(favItem.id);
    }

    console.warn(`${pluginName}: Favorite for messageId ${messageId} not found.`);
    return false;
}

/**
 * Updates the note for a favorite item
 * @param {string} favoriteId The ID of the favorite
 * @param {string} note The new note text
 */
function updateFavoriteNote(favoriteId, note) {
    console.log(`${pluginName}: updateFavoriteNote - 尝试更新 ID: ${favoriteId} 的备注`);
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
         console.warn(`${pluginName}: updateFavoriteNote - chatMetadata 无效或 favorites 数组为空`);
         return;
    }

    const favorite = chatMetadata.favorites.find(fav => fav.id === favoriteId);
    if (favorite) {
        favorite.note = note;
        console.log(`${pluginName}: 即将调用 (导入的) saveMetadataDebounced 来保存备注更新...`);
        saveMetadataDebounced(); // 调用导入的保存函数
        console.log(`${pluginName}: Updated note for favorite ${favoriteId}`);
    } else {
        console.warn(`${pluginName}: updateFavoriteNote - Favorite with id ${favoriteId} not found.`);
    }
}

/**
 * Handles the toggle of favorite status when clicking the star icon
 * @param {Event} event The click event
 */
function handleFavoriteToggle(event) {
    console.log(`${pluginName}: handleFavoriteToggle - 开始执行`);

    const target = $(event.target).closest('.favorite-toggle-icon');
    if (!target.length) {
        console.log(`${pluginName}: handleFavoriteToggle - 退出：未找到 .favorite-toggle-icon`);
        return;
    }

    const messageElement = target.closest('.mes');
    if (!messageElement || !messageElement.length) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：无法找到父级 .mes 元素`);
        return;
    }

    const messageIdString = messageElement.attr('mesid'); // mesid 字符串 (原始索引)
    if (!messageIdString) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：未找到 mesid 属性`);
        return;
    }

    const messageIndex = parseInt(messageIdString, 10);
    if (isNaN(messageIndex)) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：mesid 解析为 NaN: ${messageIdString}`);
        return;
    }

    console.log(`${pluginName}: handleFavoriteToggle - 获取 context 和消息对象 (索引: ${messageIndex})`);
    let context;
    try {
        context = getContext();
        if (!context || !context.chat) {
            console.error(`${pluginName}: handleFavoriteToggle - 退出：getContext() 返回无效或缺少 chat 属性`);
            return;
        }
    } catch (e) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：调用 getContext() 时出错:`, e);
        return;
    }

    // 从 context.chat 获取对应消息，现在 messageIdString 就是索引
    const message = context.chat[messageIndex];
    if (!message) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：在索引 ${messageIndex} 未找到消息对象 (来自 mesid ${messageIdString})`);
        return;
    }

    console.log(`${pluginName}: handleFavoriteToggle - 成功获取消息对象:`, message);

    const iconElement = target.find('i');
    if (!iconElement || !iconElement.length) {
        console.error(`${pluginName}: handleFavoriteToggle - 退出：在 .favorite-toggle-icon 内未找到 i 元素`);
        return;
    }
    const isCurrentlyFavorited = iconElement.hasClass('fa-solid');

    console.log(`${pluginName}: handleFavoriteToggle - 更新 UI，当前状态 (isFavorited): ${isCurrentlyFavorited}`);
    if (isCurrentlyFavorited) {
        iconElement.removeClass('fa-solid').addClass('fa-regular');
        console.log(`${pluginName}: handleFavoriteToggle - UI 更新为：取消收藏 (regular icon)`);
    } else {
        iconElement.removeClass('fa-regular').addClass('fa-solid');
        console.log(`${pluginName}: handleFavoriteToggle - UI 更新为：收藏 (solid icon)`);
    }

    if (!isCurrentlyFavorited) {
        console.log(`${pluginName}: handleFavoriteToggle - 准备调用 addFavorite`);
        const messageInfo = {
            messageId: messageIdString, // 传递 mesid 字符串 (原始索引)
            sender: message.name,
            role: message.is_user ? 'user' : 'character',
        };
        console.log(`${pluginName}: handleFavoriteToggle - addFavorite 参数:`, messageInfo);
        try {
            addFavorite(messageInfo);
            console.log(`${pluginName}: handleFavoriteToggle - addFavorite 调用完成`);
        } catch (e) {
             console.error(`${pluginName}: handleFavoriteToggle - 调用 addFavorite 时出错:`, e);
        }
    } else {
        console.log(`${pluginName}: handleFavoriteToggle - 准备调用 removeFavoriteByMessageId`);
        console.log(`${pluginName}: handleFavoriteToggle - removeFavoriteByMessageId 参数: ${messageIdString}`);
        try {
            // 使用 messageId (mesid 字符串) 来删除
            removeFavoriteByMessageId(messageIdString);
            console.log(`${pluginName}: handleFavoriteToggle - removeFavoriteByMessageId 调用完成`);
        } catch (e) {
             console.error(`${pluginName}: handleFavoriteToggle - 调用 removeFavoriteByMessageId 时出错:`, e);
        }
    }

    console.log(`${pluginName}: handleFavoriteToggle - 执行完毕`);
}

/**
 * Adds favorite toggle icons to all messages in the chat that don't have one
 */
function addFavoriteIconsToMessages() {
    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const extraButtonsContainer = messageElement.find('.extraMesButtons');
        if (extraButtonsContainer.length && !extraButtonsContainer.find('.favorite-toggle-icon').length) {
            extraButtonsContainer.append(messageButtonHtml);
        }
    });
}

/**
 * Updates all favorite icons in the current view to reflect current state
 */
function refreshFavoriteIconsInView() {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites)) {
        console.warn(`${pluginName}: refreshFavoriteIconsInView - 无法获取有效的 chatMetadata 或 favorites 数组`);
        $('#chat').find('.favorite-toggle-icon i').removeClass('fa-solid').addClass('fa-regular');
        return;
    }

    addFavoriteIconsToMessages(); // 确保结构存在

    $('#chat').find('.mes').each(function() {
        const messageElement = $(this);
        const messageId = messageElement.attr('mesid'); // 获取 mesid 字符串

        if (messageId) {
            // 使用 chatMetadata.favorites 检查此 mesid 是否被收藏
            const isFavorited = chatMetadata.favorites.some(fav => fav.messageId === messageId);

            const iconElement = messageElement.find('.favorite-toggle-icon i');
            if (iconElement.length) {
                if (isFavorited) {
                    iconElement.removeClass('fa-regular').addClass('fa-solid');
                } else {
                    iconElement.removeClass('fa-solid').addClass('fa-regular');
                }
            }
        }
    });
}

/**
 * Renders a single favorite item for the popup
 * @param {Object} favItem The favorite item to render
 * @param {number} index Index of the item (used for pagination, relative to sorted array)
 * @returns {string} HTML string for the favorite item
 */
function renderFavoriteItem(favItem, index) {
    if (!favItem) return '';

    const context = getContext();
    // messageId 存储的是 mesid 字符串 (原始索引)
    const messageIndex = parseInt(favItem.messageId, 10);
    let message = null;
    let previewText = '';
    let deletedClass = '';

    // 主要通过索引从 context.chat 查找
    if (!isNaN(messageIndex) && context.chat && context.chat[messageIndex]) {
         message = context.chat[messageIndex];
    }
    // (可选的后备查找，如果数据可能不一致):
    // if (!message && context.chat) {
    //     message = context.chat.find(msg => String($(msg).attr?.('mesid')) === String(favItem.messageId));
    // }

    if (message && message.mes) {
        previewText = message.mes;
        try {
             previewText = messageFormatting(previewText, favItem.sender, false,
                                            favItem.role === 'user', null, {}, false);
        } catch (e) {
             console.error(`${pluginName}: Error formatting message preview:`, e);
             previewText = message.mes; // Fallback to plain text
        }
    } else {
        previewText = '[消息内容不可用或已删除]';
        deletedClass = 'deleted';
    }

    return `
        <div class="favorite-item" data-fav-id="${favItem.id}" data-msg-id="${favItem.messageId}" data-index="${index}">
            <div class="fav-meta">${favItem.sender} (${favItem.role})</div>
            <div class="fav-note" style="${favItem.note ? '' : 'display:none;'}">备注：${favItem.note || ''}</div>
            <div class="fav-preview ${deletedClass}">${previewText}</div>
            <div class="fav-actions">
                <i class="fa-solid fa-pencil" title="编辑备注"></i>
                <i class="fa-solid fa-trash" title="删除收藏"></i>
            </div>
        </div>
    `;
}

/**
 * Updates the favorites popup with current data
 */
function updateFavoritesPopup() {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!favoritesPopup || !chatMetadata) {
        console.error(`${pluginName}: updateFavoritesPopup - Popup not ready or chatMetadata missing.`);
        return;
    }
    if (!favoritesPopup.content) {
        console.error(`${pluginName}: updateFavoritesPopup - favoritesPopup.content is null or undefined! Cannot update.`);
        return;
    }

    const context = getContext();
    const chatName = context.characterId ? context.name2 : `群组: ${context.groups?.find(g => g.id === context.groupId)?.name || '未命名群组'}`;
    const totalFavorites = chatMetadata.favorites ? chatMetadata.favorites.length : 0;
    // 按 messageId (原始索引) 升序排序，符合时间顺序
    const sortedFavorites = chatMetadata.favorites ? [...chatMetadata.favorites].sort((a, b) => parseInt(a.messageId) - parseInt(b.messageId)) : [];

    const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
    if (currentPage > totalPages) currentPage = totalPages;
    const startIndex = (currentPage - 1) * itemsPerPage;
    const endIndex = Math.min(startIndex + itemsPerPage, totalFavorites);
    const currentPageItems = sortedFavorites.slice(startIndex, endIndex);

    let contentHtml = `
        <div id="favorites-popup-content">
            <div class="favorites-header">
                <h3>${chatName} - ${totalFavorites} 条收藏</h3>
                ${totalFavorites > 0 ? `<button class="menu_button preview-favorites-btn" title="在新聊天中预览所有收藏的消息">预览收藏</button>` : ''}
            </div>
            <div class="favorites-divider"></div>
            <div class="favorites-list">
    `;

    if (totalFavorites === 0) {
        contentHtml += `<div class="favorites-empty">当前没有收藏的消息。点击消息右下角的星形图标来添加收藏。</div>`;
    } else {
        currentPageItems.forEach((favItem, index) => {
            // 注意：传递给 renderFavoriteItem 的 index 是分页后的索引，并非原始索引
            contentHtml += renderFavoriteItem(favItem, startIndex + index);
        });

        if (totalPages > 1) {
            contentHtml += `<div class="favorites-pagination">`;
            contentHtml += `<button class="menu_button pagination-prev" ${currentPage === 1 ? 'disabled' : ''}>上一页</button>`;
            contentHtml += `<span>${currentPage} / ${totalPages}</span>`;
            contentHtml += `<button class="menu_button pagination-next" ${currentPage === totalPages ? 'disabled' : ''}>下一页</button>`;
            contentHtml += `</div>`;
        }
    }

    contentHtml += `
            </div>
            <div class="favorites-footer">
                <button class="menu_button clear-invalid">清理无效收藏</button>
                <button class="menu_button close-popup">关闭</button>
            </div>
        </div>
    `;

    try {
        favoritesPopup.content.innerHTML = contentHtml;
        console.log(`${pluginName}: Popup content updated using innerHTML.`);
    } catch (error) {
         console.error(`${pluginName}: Error setting popup innerHTML:`, error);
    }
}

/**
 * Opens or updates the favorites popup
 */
function showFavoritesPopup() {
    if (!favoritesPopup) {
        try {
            favoritesPopup = new Popup(
                '<div class="spinner"></div>', // Initial loading state
                POPUP_TYPE.TEXT,
                '',
                {
                    title: '收藏管理',
                    wide: true,
                    okButton: false,
                    cancelButton: false,
                    allowVerticalScrolling: true
                }
            );
            console.log(`${pluginName}: Popup instance created successfully.`);

            // Attach event listener to the popup's content container
            $(favoritesPopup.content).on('click', function(event) {
                const target = $(event.target);

                // Handle pagination
                if (target.hasClass('pagination-prev')) {
                    if (currentPage > 1) {
                        currentPage--;
                        updateFavoritesPopup();
                    }
                } else if (target.hasClass('pagination-next')) {
                    const chatMetadata = ensureFavoritesArrayExists();
                    const totalFavorites = chatMetadata ? chatMetadata.favorites.length : 0;
                    const totalPages = Math.max(1, Math.ceil(totalFavorites / itemsPerPage));
                    if (currentPage < totalPages) {
                        currentPage++;
                        updateFavoritesPopup();
                    }
                }
                else if (target.hasClass('preview-favorites-btn')) {
                    // 1. 调用预览功能 (注意：它是异步的，但我们不需要在这里 await 它，
                    //    因为我们希望立即关闭弹窗，让预览在后台进行)
                    handlePreviewButtonClick();

                    // 2. 关闭收藏夹弹窗
                    if (favoritesPopup) { // 做个简单的安全检查
                        favoritesPopup.hide();
                        console.log(`${pluginName}: 点击预览按钮，关闭收藏夹弹窗。`);
                    }
                }
                // Handle close button
                else if (target.hasClass('close-popup')) {
                    favoritesPopup.hide();
                }
                // Handle clear invalid button
                else if (target.hasClass('clear-invalid')) {
                    handleClearInvalidFavorites();
                }
                // Handle edit note (pencil icon)
                else if (target.hasClass('fa-pencil')) {
                    const favItem = target.closest('.favorite-item');
                    if (favItem && favItem.length) {
                         const favId = favItem.data('fav-id');
                         handleEditNote(favId);
                    } else {
                         console.warn(`${pluginName}: Clicked edit icon, but couldn't find parent .favorite-item`);
                    }
                }
                // Handle delete favorite (trash icon)
                else if (target.hasClass('fa-trash')) {
                    const favItem = target.closest('.favorite-item');
                    if (favItem && favItem.length) {
                        const favId = favItem.data('fav-id');
                        const msgId = favItem.data('msg-id'); // mesid string
                        handleDeleteFavoriteFromPopup(favId, msgId);
                    } else {
                         console.warn(`${pluginName}: Clicked delete icon, but couldn't find parent .favorite-item`);
                    }
                }
            });

        } catch (error) {
            console.error(`${pluginName}: Failed during popup creation or event listener setup:`, error);
            favoritesPopup = null;
            return;
        }
    } else {
         console.log(`${pluginName}: Reusing existing popup instance.`);
    }

    currentPage = 1; // Reset to first page when opening
    updateFavoritesPopup(); // Initial content load

    if (favoritesPopup) {
        try {
            favoritesPopup.show();
        } catch(showError) {
             console.error(`${pluginName}: Error showing popup:`, showError);
        }
    }
}

/**
 * Handles the deletion of a favorite from the popup
 * @param {string} favId The favorite ID
 * @param {string} messageId The message ID (mesid string)
 */
async function handleDeleteFavoriteFromPopup(favId, messageId) {
    const confirmResult = await callGenericPopup('确定要删除这条收藏吗？', POPUP_TYPE.CONFIRM);

    if (confirmResult === POPUP_RESULT.YES) {
        if (removeFavoriteById(favId)) {
            updateFavoritesPopup(); // Update the popup list

            // Update the icon status in the main chat view
            const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
            if (messageElement.length) {
                const iconElement = messageElement.find('.favorite-toggle-icon i');
                if (iconElement.length) {
                    iconElement.removeClass('fa-solid').addClass('fa-regular');
                }
            }
        }
    }
}

/**
 * Handles editing the note for a favorite
 * @param {string} favId The favorite ID
 */
async function handleEditNote(favId) {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites)) return;

    const favorite = chatMetadata.favorites.find(fav => fav.id === favId);
    if (!favorite) return;

    const result = await callGenericPopup('为这条收藏添加备注:', POPUP_TYPE.INPUT, favorite.note || '');

    if (result !== null && result !== POPUP_RESULT.CANCELLED) {
        updateFavoriteNote(favId, result);
        updateFavoritesPopup(); // Update popup to show the new note
    }
}

/**
 * Clears invalid favorites (those referencing deleted/non-existent messages)
 */
async function handleClearInvalidFavorites() {
    const chatMetadata = ensureFavoritesArrayExists();
    if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) {
        toastr.info('当前没有收藏项可清理。');
        return;
    }

    const context = getContext();
    if (!context || !context.chat) {
         toastr.error('无法获取当前聊天信息以清理收藏。');
         return;
    }

    const invalidFavoritesIds = []; // Store IDs of invalid favorites
    const validFavorites = []; // Store valid favorite items

    chatMetadata.favorites.forEach(fav => {
        const messageIndex = parseInt(fav.messageId, 10);
        let messageExists = false;
        // Check if message exists at the specified index in the current chat
        if (!isNaN(messageIndex) && messageIndex >= 0 && context.chat[messageIndex]) {
            messageExists = true;
        }
        // Optional: Add more robust checks if needed, e.g., verifying message content/ID

        if (messageExists) {
            validFavorites.push(fav); // Keep valid favorite
        } else {
            invalidFavoritesIds.push(fav.id); // Record ID of invalid favorite
            console.log(`${pluginName}: Found invalid favorite referencing non-existent message index: ${fav.messageId}`);
        }
    });

    if (invalidFavoritesIds.length === 0) {
        toastr.info('没有找到无效的收藏项。');
        return;
    }

    const confirmResult = await callGenericPopup(
        `发现 ${invalidFavoritesIds.length} 条引用无效或已删除消息的收藏项。确定要删除这些无效收藏吗？`,
        POPUP_TYPE.CONFIRM
    );

    if (confirmResult === POPUP_RESULT.YES) {
        chatMetadata.favorites = validFavorites; // Replace with the filtered list
        saveMetadataDebounced(); // Save changes

        toastr.success(`已成功清理 ${invalidFavoritesIds.length} 条无效收藏。`);
        currentPage = 1; // Reset pagination after clearing
        updateFavoritesPopup(); // Update the popup
    }
}


/**
 * 确保预览聊天的数据存在
 * @returns {object} 包含当前聊天和角色/群组信息
 */
function ensurePreviewData() {
    const context = getContext();
    const characterId = context.characterId;
    const groupId = context.groupId;

    if (!extension_settings[pluginName].previewChats) {
        extension_settings[pluginName].previewChats = {};
    }

    return {
        characterId,
        groupId
    };
}


/**
 * 处理预览按钮点击 (Optimized Version 7.0 - No Rename)
 * 创建或切换到预览聊天，并批量填充收藏的消息，保留原始mesid，不保存，不重命名。
 */
async function handlePreviewButtonClick() {
    console.log(`${pluginName}: 预览按钮被点击 (无重命名)`);
    toastr.info('正在准备预览聊天...'); // 初始反馈

    try {
        const initialContext = getContext(); // 获取初始上下文
        if (!initialContext.groupId && initialContext.characterId === undefined) {
            console.error(`${pluginName}: 错误: 没有选择角色或群组`);
            toastr.error('请先选择一个角色或群组');
            return;
        }

        const { characterId, groupId } = ensurePreviewData();
        const chatMetadata = ensureFavoritesArrayExists();

        if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || chatMetadata.favorites.length === 0) {
            toastr.warning('没有收藏的消息可以预览');
            return;
        }
        console.log(`${pluginName}: 当前聊天收藏消息数量: ${chatMetadata.favorites.length}`);

        // 使用全局 chat 数组获取原始消息，进行深拷贝
        const originalChat = JSON.parse(JSON.stringify(initialContext.chat || []));
        console.log(`${pluginName}: 原始聊天总消息数: ${originalChat.length}`);

        const previewKey = groupId ? `group_${groupId}` : `char_${characterId}`;
        const existingPreviewChatId = extension_settings[pluginName].previewChats[previewKey];
        let targetPreviewChatId = existingPreviewChatId; // 目标聊天ID

        // --- 步骤 1: 切换或创建聊天 ---
        if (existingPreviewChatId) {
            console.log(`${pluginName}: 发现现有预览聊天ID: ${existingPreviewChatId}`);
            // **移除了重命名逻辑**

            if (initialContext.chatId === existingPreviewChatId) {
                console.log(`${pluginName}: 已在目标预览聊天 (${existingPreviewChatId})，无需切换。`);
            } else {
                console.log(`${pluginName}: 正在切换到预览聊天...`);
                if (groupId) {
                    await openGroupChat(groupId, existingPreviewChatId);
                } else {
                    // 假设 openCharacterChat 只需 chatId 即可切换
                    await openCharacterChat(existingPreviewChatId);
                }
            }
        } else {
            console.log(`${pluginName}: 未找到预览聊天ID，将创建新聊天`);
            // **移除了 isFirstPreview 标志**
            await doNewChat({ deleteCurrentChat: false }); // 创建新聊天，但不删除当前

            const newContextAfterCreation = getContext(); // 获取新聊天的上下文
            targetPreviewChatId = newContextAfterCreation.chatId;

            if (!targetPreviewChatId) {
                console.error(`${pluginName}: 创建新聊天后无法获取聊天ID`);
                throw new Error('创建预览聊天失败，无法获取新的 Chat ID');
            }
            console.log(`${pluginName}: 新聊天ID: ${targetPreviewChatId}`);
            extension_settings[pluginName].previewChats[previewKey] = targetPreviewChatId;
            saveMetadataDebounced(); // 保存新创建的预览ID映射
        }

        // --- 步骤 2: 等待聊天切换/创建完成 (事件驱动) ---
        const currentContextAfterSwitch = getContext();
        if (currentContextAfterSwitch.chatId !== targetPreviewChatId) {
            console.log(`${pluginName}: Waiting for CHAT_CHANGED event to confirm switch to ${targetPreviewChatId}...`);
            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        eventSource.off(event_types.CHAT_CHANGED, listener);
                        reject(new Error(`Waiting for CHAT_CHANGED to ${targetPreviewChatId} timed out after 5 seconds`));
                    }, 5000); // 5秒超时

                    const listener = (receivedChatId) => {
                        if (receivedChatId === targetPreviewChatId) {
                            console.log(`${pluginName}: Received expected CHAT_CHANGED event for chatId: ${receivedChatId}`);
                            clearTimeout(timeout);
                            requestAnimationFrame(resolve);
                        } else {
                            console.log(`${pluginName}: Received CHAT_CHANGED for unexpected chatId ${receivedChatId}, still waiting for ${targetPreviewChatId}`);
                        }
                    };
                    eventSource.once(event_types.CHAT_CHANGED, listener);
                });
                console.log(`${pluginName}: CHAT_CHANGED event processed and UI stable.`);
            } catch (error) {
                console.error(`${pluginName}: Error or timeout waiting for CHAT_CHANGED:`, error);
                toastr.error('切换到预览聊天时出错或超时，请重试');
                return; // 中断执行
            }
        } else {
             console.log(`${pluginName}: Already in the target chat or switch completed instantly.`);
             await new Promise(resolve => requestAnimationFrame(resolve)); // 仍然等待一帧确保UI稳定
        }

        // --- **移除了步骤 2.5: 尝试重命名新创建的聊天** ---

        // --- 步骤 3: 清空当前聊天 ---
        console.log(`${pluginName}: 清空当前 (预览) 聊天...`);
        clearChat(); // 清空界面和内部 chat 数组

        // --- 步骤 4: 等待聊天 DOM 清空 (条件驱动) ---
        console.log(`${pluginName}: Waiting for chat DOM to clear...`);
        try {
            await waitUntilCondition(() => document.querySelectorAll('#chat .mes').length === 0, 2000, 50);
            console.log(`${pluginName}: Chat DOM cleared successfully.`);
        } catch (error) {
            console.error(`${pluginName}: Waiting for chat clear timed out:`, error);
            toastr.warning('清空聊天时可能超时，继续尝试填充消息...');
        }

        // --- 步骤 5: 准备收藏消息 (健壮查找) ---
        console.log(`${pluginName}: 正在准备收藏消息以填充预览聊天...`);
        const messagesToFill = [];
        for (const favItem of chatMetadata.favorites) {
            const messageIdStr = favItem.messageId; // mesid 字符串 (原始索引)
            const messageIndex = parseInt(messageIdStr, 10);
            let foundMessage = null;

            if (!isNaN(messageIndex) && messageIndex >= 0 && messageIndex < originalChat.length) {
                if (originalChat[messageIndex]) {
                    foundMessage = originalChat[messageIndex];
                }
            }

            if (foundMessage) {
                const messageCopy = JSON.parse(JSON.stringify(foundMessage));
                if (!messageCopy.extra) messageCopy.extra = {};
                if (!messageCopy.extra.swipes) messageCopy.extra.swipes = [];

                messagesToFill.push({
                    message: messageCopy,
                    mesid: messageIndex
                });
            } else {
                console.warn(`${pluginName}: Warning: Favorite message with original mesid ${messageIdStr} not found in original chat snapshot (length ${originalChat.length}). Skipping.`);
            }
        }

        messagesToFill.sort((a, b) => a.mesid - b.mesid);
        console.log(`${pluginName}: 找到 ${messagesToFill.length} 条有效收藏消息可以填充`);

        // --- 步骤 6: 批量填充消息 ---
        const finalContext = getContext(); // 获取填充操作开始时的最终上下文
        // *** 关键检查：现在因为没有重命名，这个检查应该总是通过 ***
        if (finalContext.chatId !== targetPreviewChatId) {
             console.error(`${pluginName}: Error: Context switched unexpectedly after waiting/clearing. Expected ${targetPreviewChatId}, got ${finalContext.chatId}. Aborting fill.`);
             toastr.error('无法确认预览聊天环境，填充操作中止。请重试。');
             return; // 中断执行
        }
        console.log(`${pluginName}: Confirmed context for chatId ${finalContext.chatId}. Starting batch fill...`);

        let addedCount = 0;
        const BATCH_SIZE = 20;

        for (let i = 0; i < messagesToFill.length; i += BATCH_SIZE) {
            const batch = messagesToFill.slice(i, i + BATCH_SIZE);
            console.log(`${pluginName}: Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(messagesToFill.length / BATCH_SIZE)} (${batch.length} messages)`);

            for (const item of batch) {
                try {
                    const message = item.message;
                    const originalMesid = item.mesid;

                    await finalContext.addOneMessage(message, {
                        scroll: false,
                        forceId: originalMesid
                    });
                    addedCount++;

                } catch (error) {
                    console.error(`${pluginName}: Error adding message (original mesid=${item.mesid}):`, error);
                }
            }

            if (i + BATCH_SIZE < messagesToFill.length) {
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
        }

        console.log(`${pluginName}: All batches processed. Total messages added: ${addedCount}`);

        // --- 步骤 7: 完成与最终处理 ---
        if (addedCount > 0) {
            console.log(`${pluginName}: Preview population complete. No save or scroll performed.`);
            // (可选) 提示用户预览聊天的实际 ID (文件名)
            const finalPreviewContext = getContext();
            if (finalPreviewContext.chatId === targetPreviewChatId) {
                 toastr.success(`已在预览聊天 (${targetPreviewChatId}) 中显示 ${addedCount} 条收藏消息`);
            } else {
                 // 如果上下文又意外改变了，给个通用提示
                 toastr.success(`已在预览聊天中显示 ${addedCount} 条收藏消息`);
            }
        } else if (messagesToFill.length > 0) {
             console.warn(`${pluginName}: No messages were successfully added, although ${messagesToFill.length} were prepared.`);
             toastr.warning('准备了收藏消息，但未能成功添加到预览中。请检查控制台。');
        } // 如果 messagesToFill 本来就是空的，在函数开头已经处理

    } catch (error) {
        console.error(`${pluginName}: Error during preview generation:`, error);
        const errorMsg = (error instanceof Error && error.message) ? error.message : '请查看控制台获取详细信息';
        toastr.error(`创建预览时出错: ${errorMsg}`);
    }
}


/**
 * Main entry point for the plugin
 */
jQuery(async () => {
    try {
        console.log(`${pluginName}: 插件加载中...`);

        // Inject CSS styles (unchanged from original)
        const styleElement = document.createElement('style');
        styleElement.innerHTML = `
            /* Favorites popup styles */
            .favorites-popup-content { /* Assuming this is a typo and should be #favorites-popup-content */
                padding: 10px;
                max-height: 70vh;
                overflow-y: auto;
            }
            #favorites-popup-content .favorites-header { /* More specific selector */
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 0 10px;
            }
            #favorites-popup-content .favorites-header h3 {
                text-align: center;
                margin: 0;
            }
            #favorites-popup-content .favorites-divider {
                height: 1px;
                background-color: #ccc;
                margin: 10px 0;
            }
            #favorites-popup-content .favorites-list {
                margin: 10px 0;
            }
            #favorites-popup-content .favorites-empty {
                text-align: center;
                color: #888;
                padding: 20px;
            }
            #favorites-popup-content .favorite-item {
                border: 1px solid #444;
                border-radius: 8px;
                margin-bottom: 10px;
                padding: 10px;
                background-color: rgba(0, 0, 0, 0.2);
                position: relative;
            }
            #favorites-popup-content .fav-meta {
                font-size: 0.8em;
                color: #aaa;
                margin-bottom: 5px;
            }
            #favorites-popup-content .fav-note {
                background-color: rgba(255, 255, 0, 0.1);
                padding: 5px;
                border-left: 3px solid #ffcc00;
                margin-bottom: 5px;
                font-style: italic;
            }
            #favorites-popup-content .fav-preview {
                margin-bottom: 5px;
                line-height: 1.4;
                max-height: 200px; /* Consider if this is still needed/appropriate */
                overflow-y: auto;
                word-wrap: break-word;
                white-space: pre-wrap;
            }
            #favorites-popup-content .fav-preview.deleted {
                color: #ff3a3a;
                font-style: italic;
            }
            #favorites-popup-content .fav-actions {
                text-align: right;
            }
            #favorites-popup-content .fav-actions i {
                cursor: pointer;
                margin-left: 10px;
                padding: 5px;
                border-radius: 50%;
                transition: background-color 0.2s; /* Smooth hover */
            }
            #favorites-popup-content .fav-actions i:hover {
                background-color: rgba(255, 255, 255, 0.1);
            }
            #favorites-popup-content .fav-actions .fa-pencil { /* More specific */
                color: #3a87ff;
            }
            #favorites-popup-content .fav-actions .fa-trash { /* More specific */
                color: #ff3a3a;
            }
            /* Star icon styles (unchanged) */
            .favorite-toggle-icon {
                cursor: pointer;
            }
            .favorite-toggle-icon i.fa-regular {
                color: #999;
            }
            .favorite-toggle-icon i.fa-solid {
                color: #ffcc00; /* Gold color for favorited */
            }
            /* Pagination styles (unchanged) */
            #favorites-popup-content .favorites-pagination {
                display: flex;
                justify-content: center;
                align-items: center;
                margin-top: 10px;
                gap: 10px;
            }
            #favorites-popup-content .favorites-footer {
                display: flex;
                justify-content: space-between;
                align-items: center; /* Align buttons vertically */
                margin-top: 15px;
                padding-top: 10px; /* Add some space above footer */
                border-top: 1px solid #444; /* Separator line */
            }
        `;
        document.head.appendChild(styleElement);

        // Add button to the data bank wand container (unchanged)
        try {
            // Assuming the template path uses pluginName correctly
            const inputButtonHtml = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'input_button');
            $('#data_bank_wand_container').append(inputButtonHtml);
            console.log(`${pluginName}: 已将按钮添加到 #data_bank_wand_container`);

            $('#favorites_button').on('click', () => {
                showFavoritesPopup();
            });
        } catch (error) {
            console.error(`${pluginName}: 加载或注入 input_button.html 失败:`, error);
        }

        // Add settings to extension settings (unchanged)
        try {
             // Assuming the template path uses pluginName correctly
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginName}`, 'settings_display');
            $('#extensions_settings').append(settingsHtml); // Target the correct container if #translation_container was wrong
            console.log(`${pluginName}: 已将设置 UI 添加到 #extensions_settings (或目标容器)`);
        } catch (error) {
            console.error(`${pluginName}: 加载或注入 settings_display.html 失败:`, error);
        }

        // Set up event delegation for favorite toggle icon (unchanged)
        $(document).on('click', '.favorite-toggle-icon', handleFavoriteToggle);

        // Initialize favorites array for current chat on load (unchanged)
        ensureFavoritesArrayExists();

        // Initial UI setup (unchanged)
        addFavoriteIconsToMessages();
        refreshFavoriteIconsInView();

        // --- Event Listeners (Largely unchanged, logic adapted where needed) ---
        eventSource.on(event_types.CHAT_CHANGED, () => {
            console.log(`${pluginName}: 聊天已更改，更新收藏图标...`);
            ensureFavoritesArrayExists(); // Ensure array exists for the new chat
            setTimeout(() => {
                addFavoriteIconsToMessages(); // Add icons structure to potentially new messages
                refreshFavoriteIconsInView(); // Update icon states based on new chat's metadata
            }, 150); // Slightly longer delay might be safer after chat change
        });

        eventSource.on(event_types.MESSAGE_DELETED, (deletedMessageIndex) => {
            // MESSAGE_DELETED usually provides the index of the deleted message
            const deletedMessageId = String(deletedMessageIndex); // Convert index to string for comparison
            console.log(`${pluginName}: 检测到消息删除事件, 索引: ${deletedMessageIndex}`);
            const chatMetadata = ensureFavoritesArrayExists();
            if (!chatMetadata || !Array.isArray(chatMetadata.favorites) || !chatMetadata.favorites.length) return;

            // Find if any favorite references this messageId (index string)
            const favIndex = chatMetadata.favorites.findIndex(fav => fav.messageId === deletedMessageId);

            if (favIndex !== -1) {
                console.log(`${pluginName}: 消息索引 ${deletedMessageIndex} (ID: ${deletedMessageId}) 被删除，移除对应的收藏项`);
                chatMetadata.favorites.splice(favIndex, 1);
                saveMetadataDebounced(); // Save changes

                // Update popup if visible
                if (favoritesPopup && favoritesPopup.dlg && favoritesPopup.dlg.hasAttribute('open')) {
                    currentPage = 1; // Reset page as list changed
                    updateFavoritesPopup();
                }
            } else {
                 console.log(`${pluginName}: 未找到引用已删除消息索引 ${deletedMessageIndex} (ID: ${deletedMessageId}) 的收藏项`);
            }
             // Refresh icons in view in case the deleted message was visible
             setTimeout(refreshFavoriteIconsInView, 100);
        });

        // Listener for when new messages appear (sent or received)
        const handleNewMessage = () => {
             setTimeout(() => {
                 addFavoriteIconsToMessages(); // Ensure new messages get the icon structure
                 // refreshFavoriteIconsInView(); // Usually not needed, new icons are default (empty star)
             }, 150); // Delay to wait for DOM update
        };
        eventSource.on(event_types.MESSAGE_RECEIVED, handleNewMessage);
        eventSource.on(event_types.MESSAGE_SENT, handleNewMessage);
        eventSource.on(event_types.MESSAGE_SWIPED, () => { // Swiping might change visible messages
            setTimeout(refreshFavoriteIconsInView, 150);
        });
        eventSource.on(event_types.MESSAGE_UPDATED, () => { // Message content edit might affect previews? Refresh needed.
             setTimeout(refreshFavoriteIconsInView, 150);
        });


        // Listener for when more messages are loaded (scrolling up)
        eventSource.on(event_types.MORE_MESSAGES_LOADED, () => {
             console.log(`${pluginName}: 加载了更多消息，更新图标...`);
             setTimeout(() => {
                 addFavoriteIconsToMessages(); // Add icon structure to newly loaded messages
                 refreshFavoriteIconsInView(); // Update states for all visible icons
             }, 150);
        });

        // MutationObserver (unchanged, still a good fallback)
        const chatObserver = new MutationObserver((mutations) => {
            let needsIconAddition = false;
            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length) {
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1 && (node.classList.contains('mes') || node.querySelector('.mes'))) {
                            needsIconAddition = true;
                        }
                    });
                }
            }
            if (needsIconAddition) {
                 // Debounce or throttle might be better, but setTimeout is simpler here
                 setTimeout(addFavoriteIconsToMessages, 200); // Longer delay for observer fallback
            }
        });

        const chatElement = document.getElementById('chat');
        if (chatElement) {
            chatObserver.observe(chatElement, {
                childList: true,
                subtree: true // Observe descendants as well
            });
             console.log(`${pluginName}: MutationObserver 已启动，监视 #chat 的变化`);
        } else {
             console.error(`${pluginName}: 未找到 #chat 元素，无法启动 MutationObserver`);
        }


        console.log(`${pluginName}: 插件加载完成! (已应用优化方案 7.0)`);
    } catch (error) {
        console.error(`${pluginName}: 初始化过程中出错:`, error);
    }
});
